import { describe, expect, it, vi } from "vitest";
import { Platform, requireApiVersion } from "obsidian";
import { sha256Hex } from "../src/crypto";
import type { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import {
  SyncExecutor,
  type AutomaticHandlingMetrics,
  type SyncResult,
} from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { StateManager } from "../src/sync/state-manager";
import {
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import { projectStatePathViewV2 } from "../src/sync/file-state-controller-v2";
import { acceptConfirmedDescendantFolderAnchorsV2 } from
  "../src/sync/folder-state-reducer-v2";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";
import {
  readCommunityPluginSyncPolicy,
  type CommunityPluginSyncPolicyV1,
} from "../src/sync/community-plugin-sync-policy";
import {
  enableCommunityPluginDataWithFiles,
  updateCommunityPluginSelection,
} from "../src/sync/community-plugin-selection-update";
import { SyncProgressStore } from "../src/sync/sync-progress";
import type {
  CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";
import type {
  CommunityPluginJoinAuthorization,
} from "../src/sync/community-plugin-join";
import { validateCommunityPluginJoinAuthorization } from "../src/sync/community-plugin-join";
import type {
  BaseFileEntry,
  LocalFileEntry,
  LocalFolderEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlan,
  SyncPlanItem,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";
import {
  communityPluginGenerationObjectPathV1,
  createCommunityPluginBundlePublicationCommandV1,
  createCommunityPluginGenerationContentGrantV1,
  prepareCommunityPluginGenerationBundleManifestV1,
} from "../src/sync/community-plugin-generation-content-v1";
import {
  createCommunityPluginLifecycleControlV1,
  reduceCommunityPluginLifecycleV1,
  type CommunityPluginLifecycleCommandV1,
  type CommunityPluginLifecycleControlV1,
  type CommunityPluginParticipantIdentityV1,
} from "../src/sync/community-plugin-lifecycle-v1";
import {
  CommunityPluginLifecycleDeviceObserverV1,
  loadOrCreateCommunityPluginLifecycleDeviceIdentityV1,
} from "../src/sync/community-plugin-lifecycle-device-v1";
import type { VaultLocalStorage } from
  "../src/sync/indexeddb-vault-namespace";

const SCOPE = {
  accountId: "account-id",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};
const COMMUNITY_PATH = ".obsidian/community-plugins.json";
const REMOTE_FOLDERS: RemoteFolderEntry[] = [
  {
    path: ".obsidian",
    driveId: "obsidian-folder-id",
    parentId: SCOPE.filesRootId,
    name: ".obsidian",
  },
  {
    path: ".obsidian/plugins",
    driveId: "plugins-folder-id",
    parentId: "obsidian-folder-id",
    name: "plugins",
  },
  {
    path: ".obsidian/plugins/calendar",
    driveId: "plugin-folder-id",
    parentId: "plugins-folder-id",
    name: "calendar",
  },
];
const PLUGIN_MANIFEST_TEXT = JSON.stringify({
  id: "calendar",
  version: "2.0.0",
  minAppVersion: "1.5.0",
});

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function localEntry(path: string, content: ArrayBuffer): Promise<LocalFileEntry> {
  return {
    path,
    size: content.byteLength,
    mtime: 1,
    hash: await sha256Hex(content),
    binary: false,
  };
}

async function remoteEntry(
  path: string,
  content: ArrayBuffer,
  overrides: Partial<RemoteFileEntry> = {},
): Promise<RemoteFileEntry> {
  return {
    path,
    driveId: `id:${path}`,
    parentId: path === COMMUNITY_PATH ? "obsidian-folder-id" : "plugin-folder-id",
    size: content.byteLength,
    mtime: 1,
    eTag: `etag:${path}`,
    cTag: `ctag:${path}`,
    sha256Hash: await sha256Hex(content),
    ...overrides,
  };
}

function completeRemoteItems(
  entries: readonly RemoteFileEntry[],
  folders: readonly RemoteFolderEntry[] = REMOTE_FOLDERS,
) {
  return [
    ...folders.map((folder) => ({
      id: folder.driveId,
      name: folder.name,
      folder: {},
      parentReference: { id: folder.parentId },
      eTag: folder.eTag,
    })),
    ...entries.map((entry) => ({
      id: entry.driveId,
      name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      size: entry.size,
      file: {
        hashes: {
          sha256Hash: entry.sha256Hash,
          quickXorHash: entry.quickXorHash,
        },
      },
      parentReference: { id: entry.parentId },
      lastModifiedDateTime: new Date(entry.mtime).toISOString(),
      eTag: entry.eTag,
      cTag: entry.cTag,
      "@microsoft.graph.downloadUrl": entry.downloadUrl,
    })),
  ];
}

function sharedBaseEntry(
  local: LocalFileEntry,
  remote: RemoteFileEntry,
): BaseFileEntry {
  return {
    path: local.path,
    size: local.size,
    hash: local.hash,
    eTag: remote.eTag,
  };
}

function joinAuthorization(
  entries: readonly RemoteFileEntry[],
): CommunityPluginJoinAuthorization {
  return {
    pluginId: "calendar",
    operationId: "join-calendar-1",
    targetCatalogRevision: 7,
    targetBundleDigest: "a".repeat(64),
    scope: SCOPE,
    members: entries.map((entry) => ({
      path: entry.path,
      remoteId: entry.driveId,
      parentId: entry.parentId,
      size: entry.size,
      mtime: entry.mtime,
      eTag: entry.eTag,
      cTag: entry.cTag,
      sha256Hash: entry.sha256Hash ?? null,
      quickXorHash: entry.quickXorHash ?? null,
    })),
  };
}

function applyLifecycleCommand(
  state: CommunityPluginLifecycleControlV1,
  input: Omit<
    CommunityPluginLifecycleCommandV1,
    "scope" | "expectedRevision" | "at" | "operationId"
  >,
  operationId: string,
  at: number,
): CommunityPluginLifecycleControlV1 {
  const reduced = reduceCommunityPluginLifecycleV1(state, {
    ...input,
    operationId,
    expectedRevision: state.revision,
    scope: SCOPE,
    at,
  } as CommunityPluginLifecycleCommandV1);
  if (reduced.status !== "applied") {
    throw new Error(`lifecycle fixture blocked: ${reduced.reason}`);
  }
  return reduced.state;
}

function makeMemoryAdapter(initial: Record<string, ArrayBuffer | string>) {
  const binary = new Map<string, ArrayBuffer>();
  const text = new Map<string, string>();
  for (const [path, value] of Object.entries(initial)) {
    if (typeof value === "string") text.set(path, value);
    else binary.set(path, value.slice(0));
  }
  return {
    binary,
    text,
    adapter: {
      read: vi.fn(async (path: string) => {
        const value = text.get(path);
        if (value === undefined) throw new Error(`missing ${path}`);
        return value;
      }),
      write: vi.fn(async (path: string, value: string) => {
        text.set(path, value);
      }),
      readBinary: vi.fn(async (path: string) => {
        const value = binary.get(path);
        if (!value) throw new Error(`missing ${path}`);
        return value.slice(0);
      }),
      writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
        binary.set(path, value.slice(0));
      }),
      appendBinary: vi.fn(),
      remove: vi.fn(async (path: string) => {
        binary.delete(path);
        text.delete(path);
      }),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn(async (source: string, target: string) => {
        if (binary.has(source)) {
          binary.set(target, binary.get(source)!);
          binary.delete(source);
          return;
        }
        if (text.has(source)) {
          text.set(target, text.get(source)!);
          text.delete(source);
          return;
        }
        throw new Error(`missing ${source}`);
      }),
      exists: vi.fn(async (path: string) => binary.has(path) || text.has(path)),
      stat: vi.fn(async (path: string) => {
        const binaryValue = binary.get(path);
        if (binaryValue) return { size: binaryValue.byteLength, mtime: 1 };
        const textValue = text.get(path);
        return textValue === undefined
          ? null
          : { size: new TextEncoder().encode(textValue).byteLength, mtime: 1 };
      }),
    },
  };
}

function makeVaultLocalStorage(): VaultLocalStorage & {
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  return {
    values,
    loadLocalStorage(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    saveLocalStorage(key, value) {
      if (value === null) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
}

function makeState(
  remoteEntries: RemoteFileEntry[],
  baseEntries: BaseFileEntry[] = [],
  overrides: Record<string, unknown> = {},
  remoteFolders: RemoteFolderEntry[] = REMOTE_FOLDERS,
  folderAnchorFolders: readonly RemoteFolderEntry[] = remoteFolders,
): StateManager {
  const createEnvelope = (
    entries: RemoteFileEntry[],
    folders: RemoteFolderEntry[],
    bases: BaseFileEntry[],
    commitSeq: number,
    committedAt: number,
  ) => {
    const candidate = createFileStateShadowEnvelopeV2({
      scope: SCOPE,
      lifecycleEpoch: 1,
      commitSeq,
      committedAt,
      remoteEntries: entries,
      remoteFolders: folders,
      baseEntries: bases,
    });
    candidate.remoteIndex.deltaLink = "delta-token";
    candidate.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(folderAnchorFolders.map((folder) => [
        `folder:${folder.driveId}`,
        {
          anchorId: `folder:${folder.driveId}`,
          remoteId: folder.driveId,
          lastPath: folder.path,
          parentRemoteId: folder.parentId,
          confirmedGeneration: commitSeq,
          confirmedAt: committedAt,
        },
      ])),
    };
    return candidate;
  };
  let envelope = createEnvelope(
    remoteEntries,
    remoteFolders,
    baseEntries,
    1,
    1,
  );
  let manifestObservations: CommunityPluginManifestObservationV1[] = [];
  const state = {
    legacyAutoSyncAllowed: false,
    isV2StateActive: true,
    retireAllFirstSyncVerificationEvidence: vi.fn().mockResolvedValue(0),
    boundAccountId: SCOPE.accountId,
    hasRemoteState: true,
    remoteScope: SCOPE,
    remoteDeltaLink: "delta-token",
    remoteSnapshot: remoteEntries,
    remoteFolders,
    remoteGeneration: 0,
    hasCompleteRemoteFolderIndex: true,
    baseSnapshot: baseEntries,
    pendingConflicts: [],
    pendingRemoteDeletes: [],
    pendingIssues: [],
    mutationLedger: [],
    localFolderMoveHints: [],
    hasMutationLedgerCorruption: false,
    planReviewActive: false,
    planReviewRevision: 0,
    planReviewScope: null,
    planReviewDigest: "",
    getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
    acceptConfirmedDescendantFolderAnchors: vi.fn(async (input) => {
      const reduced = acceptConfirmedDescendantFolderAnchorsV2({
        envelope,
        localFiles: input.localFiles,
        localFolders: input.localFolders,
        localFolderScanComplete: input.localFolderScanComplete,
        remoteIdentityComplete: input.remoteIdentityComplete,
        includeFilePath: input.includeFilePath,
        includeFolderPath: input.includeFolderPath,
        confirmedAt: input.now ?? Date.now(),
      });
      if (reduced.status === "accepted" && reduced.accepted > 0) {
        envelope = reduced.envelope;
      }
      return reduced.status === "rejected"
        ? {
            status: "rejected" as const,
            reason: reduced.reason,
            accepted: 0,
            evidenceFiles: 0,
          }
        : {
            status: reduced.accepted > 0 ? "accepted" as const : "none" as const,
            accepted: reduced.accepted,
            evidenceFiles: reduced.evidenceFiles,
          };
    }),
    getBaseEntry: vi.fn((path: string) =>
      state.baseSnapshot.find((entry) => entry.path === path)),
    getBaseContent: vi.fn().mockResolvedValue(undefined),
    setRemoteState: vi.fn(),
    clearRemoteState: vi.fn().mockResolvedValue(undefined),
    applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
    upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
    removeBaseEntries: vi.fn().mockResolvedValue(undefined),
    prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
    prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
    prunePendingIssues: vi.fn().mockResolvedValue(undefined),
    upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
    removePendingConflict: vi.fn().mockResolvedValue(undefined),
    upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
    removePendingDelete: vi.fn().mockResolvedValue(undefined),
    reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
    setLastSyncTime: vi.fn().mockResolvedValue(undefined),
    incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    cacheBaseContent: vi.fn(),
    getCommunityPluginEnablementState: vi.fn().mockReturnValue({
      version: 1,
      scope: SCOPE,
      anchors: {},
      pending: [],
    }),
    setCommunityPluginEnablementState: vi.fn().mockResolvedValue(undefined),
    getCommunityPluginManifestObservations: vi.fn(
      () => structuredClone(manifestObservations),
    ),
    setCommunityPluginManifestObservations: vi.fn(async (
      observations: CommunityPluginManifestObservationV1[],
    ) => {
      manifestObservations = structuredClone(observations);
    }),
    ...overrides,
  } as unknown as StateManager & {
    mutationLedger: Array<{
      intent: { operationId: string };
      receipt: { operationId: string } | null;
    }>;
  };
  state.beginMutationIntent = vi.fn(async (intent) => {
    state.mutationLedger.push({ intent, receipt: null });
  });
  state.recordMutationReceipt = vi.fn(async (receipt) => {
    const entry = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === receipt.operationId,
    );
    if (!entry) throw new Error(`Mutation intent missing: ${receipt.operationId}`);
    entry.receipt = receipt;
  });
  state.abandonMutationIntent = vi.fn(async (operationId) => {
    const index = state.mutationLedger.findIndex(
      (entry) => entry.intent.operationId === operationId,
    );
    if (index >= 0) state.mutationLedger.splice(index, 1);
  });
  state.commitMutationCheckpoint = vi.fn(async (operationId) => {
    const index = state.mutationLedger.findIndex(
      (entry) => entry.intent.operationId === operationId,
    );
    if (index < 0 || !state.mutationLedger[index].receipt) {
      throw new Error(`Mutation receipt missing: ${operationId}`);
    }
    const record = state.mutationLedger[index];
    envelope = reduceFileStateEnvelopeV2(envelope, record as never);
    const projection = projectStatePathViewV2(envelope);
    state.baseSnapshot = projection.baseEntries;
    state.remoteSnapshot = projection.remoteEntries;
    state.remoteFolders = projection.remoteFolders;
    state.remoteDeltaLink = projection.deltaLink;
    state.mutationLedger.splice(index, 1);
  });
  state.commitMutationCheckpoints = vi.fn(async (operationIds) => {
    const records = operationIds.map((operationId) => {
      const record = state.mutationLedger.find(
        (entry) => entry.intent.operationId === operationId,
      );
      if (!record?.receipt) {
        throw new Error(`Mutation receipt missing: ${operationId}`);
      }
      return record;
    });
    const sourceCommitSeq = envelope.meta.commitSeq;
    const sourceCommittedAt = envelope.meta.committedAt;
    for (const record of records) {
      envelope = reduceFileStateEnvelopeV2(envelope, record as never);
    }
    envelope = {
      ...envelope,
      meta: {
        ...envelope.meta,
        commitSeq: sourceCommitSeq + 1,
        committedAt: sourceCommittedAt + 1,
      },
    };
    const projection = projectStatePathViewV2(envelope);
    state.baseSnapshot = projection.baseEntries;
    state.remoteSnapshot = projection.remoteEntries;
    state.remoteFolders = projection.remoteFolders;
    state.remoteDeltaLink = projection.deltaLink;
    const committedIds = new Set(operationIds);
    state.mutationLedger = state.mutationLedger.filter(
      (entry) => !committedIds.has(entry.intent.operationId),
    );
  });
  state.setRemoteState = vi.fn(async (
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: typeof SCOPE,
    folders: RemoteFolderEntry[] = [],
  ) => {
    envelope = createEnvelope(
      entries,
      folders,
      state.baseSnapshot,
      envelope.meta.commitSeq + 1,
      envelope.meta.committedAt + 1,
    );
    envelope.scope = { ...scope };
    envelope.remoteIndex.deltaLink = deltaLink;
    state.remoteSnapshot = entries;
    state.remoteFolders = folders;
    state.remoteDeltaLink = deltaLink;
    state.remoteScope = scope;
  });
  return state;
}

function makeOneDrive(
  remoteContent: ArrayBuffer | null,
  overrides: Record<string, unknown> = {},
): OneDriveClient {
  return {
    downloadBaseline: vi.fn().mockResolvedValue(null),
    downloadFile: vi.fn().mockResolvedValue(remoteContent ?? new ArrayBuffer(0)),
    uploadFile: vi.fn().mockResolvedValue({
      id: "community-file-id",
      eTag: "etag:new",
      size: remoteContent?.byteLength ?? 0,
      parentReference: { id: SCOPE.filesRootId },
    }),
    restoreVaultScope: vi.fn().mockReturnValue(true),
    initVaultScope: vi.fn().mockResolvedValue({
      driveId: SCOPE.driveId,
      vaultFolderId: SCOPE.vaultFolderId,
      filesRootId: SCOPE.filesRootId,
    }),
    isDeltaLinkForVault: vi.fn().mockReturnValue(true),
    getDelta: vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "delta-token-next",
    }),
    resetDownloadStrategy: vi.fn(),
    setAbortSignal: vi.fn(),
    ...overrides,
  } as unknown as OneDriveClient;
}

function makeExecutor(options: {
  localEntries: LocalFileEntry[];
  remoteEntries: RemoteFileEntry[];
  remoteContent: ArrayBuffer | null;
  adapter: ReturnType<typeof makeMemoryAdapter>["adapter"];
  state?: StateManager;
  oneDrive?: OneDriveClient;
  policy?: CommunityPluginSyncPolicyV1;
  localFolders?: LocalFolderEntry[];
  remoteFolders?: RemoteFolderEntry[];
  shouldSyncFolderPath?: (path: string) => boolean;
  diag?: ConstructorParameters<typeof SyncExecutor>[6];
  progressStore?: SyncProgressStore;
  lifecycleObserver?: ConstructorParameters<typeof SyncExecutor>[11];
}): {
  executor: SyncExecutor;
  state: StateManager;
  oneDrive: OneDriveClient;
} {
  const state = options.state ?? makeState(
    options.remoteEntries,
    [],
    {},
    options.remoteFolders,
  );
  const oneDrive = options.oneDrive ?? makeOneDrive(options.remoteContent);
  const scanner = {
    vault: {
      adapter: options.adapter,
      configDir: ".obsidian",
      getName: vi.fn().mockReturnValue("testVault"),
    },
    scanAll: vi.fn().mockResolvedValue({
      entries: options.localEntries,
      folders: options.localFolders ?? REMOTE_FOLDERS.map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }),
    inspectFile: vi.fn(async (path: string) => {
      const stat = await options.adapter.stat(path);
      if (!stat) return { status: "missing" as const };
      const content = await options.adapter.readBinary(path);
      return {
        status: "present" as const,
        entry: {
          path,
          size: stat.size,
          mtime: stat.mtime,
          hash: await sha256Hex(content),
        },
      };
    }),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn(
      options.shouldSyncFolderPath ?? (() => true),
    ),
    getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
  } as unknown as LocalScanner;
  const executor = new SyncExecutor(
    oneDrive,
    scanner,
    state,
    "testVault",
    undefined,
    options.progressStore,
    options.diag,
    undefined,
    undefined,
    undefined,
    undefined,
    options.lifecycleObserver,
  );
  executor.setCommunityPluginSyncPolicy(options.policy ?? {
    version: 1,
    files: { mode: "selected", pluginIds: ["calendar"] },
    data: { mode: "none", pluginIds: [] },
  });
  return { executor, state, oneDrive };
}

describe("community plugin enablement runtime", () => {
  it("restores a sealed generation through the ordinary bundle and local-only ledger chain", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainContent = bytes("generation-main");
    const manifestContent = bytes(PLUGIN_MANIFEST_TEXT);
    const mainHash = await sha256Hex(mainContent);
    const manifestHash = await sha256Hex(manifestContent);
    const sourceRoot =
      "community-plugin-content-v1/plugins/63616c656e646172/generations/1/objects";
    const remoteMain = await remoteEntry(
      `${sourceRoot}/${mainHash}.bin`,
      mainContent,
      {
        driveId: "generation-main-id",
        parentId: "generation-objects-parent",
        eTag: "generation-main-etag",
        cTag: "generation-main-ctag",
      },
    );
    const remoteManifest = await remoteEntry(
      `${sourceRoot}/${manifestHash}.bin`,
      manifestContent,
      {
        driveId: "generation-manifest-id",
        parentId: "generation-objects-parent",
        eTag: "generation-manifest-etag",
        cTag: "generation-manifest-ctag",
      },
    );
    const generationRestore = {
      schemaVersion: 1 as const,
      pluginId: "calendar",
      participant: {
        participantId: "participant-a",
        incarnation: "incarnation-a",
      },
      generation: 1,
      joinNonce: "join-nonce-a",
      controlRecordId: "lifecycle-control-id",
      fenceEpoch: 4,
      sealRevision: 9,
      manifestObject: {
        objectPath:
          "community-plugin-content-v1/plugins/63616c656e646172/generations/1/manifests/"
          + `${"d".repeat(64)}.json`,
        remoteId: "bundle-manifest-id",
        parentId: "generation-manifests-parent",
        size: 100,
        eTag: "bundle-manifest-etag",
        cTag: "bundle-manifest-ctag",
        sha256Hash: "d".repeat(64),
      },
    };
    const participantKey = "participant-a::incarnation-a";
    const publishedBundle = {
      publicationRevision: 8,
      publisher: { ...generationRestore.participant },
      publisherJoinNonce: generationRestore.joinNonce,
      publishedAt: 8,
      publishedFenceEpoch: 3,
      manifestObject: { ...generationRestore.manifestObject },
    };
    const lifecycleControl = {
      schemaVersion: 2 as const,
      kind: "community-plugin-lifecycle-control" as const,
      scope: { ...SCOPE },
      revision: 9,
      fenceEpoch: generationRestore.fenceEpoch,
      participantsByKey: {
        [participantKey]: {
          identity: { ...generationRestore.participant },
          registeredAt: 1,
          lastObservedAt: 9,
          registeredFenceEpoch: 0,
        },
      },
      pluginsById: {
        calendar: {
          pluginId: "calendar",
          generationHighWatermark: 1,
          currentGeneration: {
            generation: 1,
            phase: "open" as const,
            openedAt: 2,
            membersByKey: {
              [participantKey]: {
                identity: { ...generationRestore.participant },
                phase: "joined" as const,
                joinNonce: generationRestore.joinNonce,
                joinEvidence: "user-confirmed" as const,
                joinedAt: 3,
                joinedFenceEpoch: 0,
              },
            },
            publishedBundle,
          },
          closedTombstones: [],
          legacyAuthoritySeal: {
            generation: 1,
            sealedBy: { ...generationRestore.participant },
            sealedAt: 9,
            sealedRevision: generationRestore.sealRevision,
            sealedFenceEpoch: generationRestore.fenceEpoch,
            consentRevision: 6,
            publishedBundle,
          },
        },
      },
      legacyMigrationConsent: {
        confirmedBy: { ...generationRestore.participant },
        confirmedAt: 6,
        confirmedRevision: 6,
        confirmedFenceEpoch: 2,
        evidence: "user-confirmed-legacy-devices-upgraded-or-retired" as const,
      },
    };
    const generationProjection = {
      schemaVersion: 1 as const,
      capability: "restore-sealed-generation-bundle" as const,
      scope: { ...SCOPE },
      participant: { ...generationRestore.participant },
      pluginId: "calendar",
      generation: 1,
      joinNonce: generationRestore.joinNonce,
      controlRecordId: generationRestore.controlRecordId,
      observedControlRevision: lifecycleControl.revision,
      fenceEpoch: generationRestore.fenceEpoch,
      sealRevision: generationRestore.sealRevision,
      configDir: ".obsidian",
      manifestObject: { ...generationRestore.manifestObject },
      members: [
        {
          fileName: "main.js" as const,
          targetPath: mainPath,
          source: {
            fileName: "main.js" as const,
            objectPath: remoteMain.path,
            remoteId: remoteMain.driveId,
            parentId: remoteMain.parentId,
            size: remoteMain.size,
            eTag: remoteMain.eTag,
            cTag: remoteMain.cTag!,
            sha256Hash: mainHash,
          },
        },
        {
          fileName: "manifest.json" as const,
          targetPath: manifestPath,
          source: {
            fileName: "manifest.json" as const,
            objectPath: remoteManifest.path,
            remoteId: remoteManifest.driveId,
            parentId: remoteManifest.parentId,
            size: remoteManifest.size,
            eTag: remoteManifest.eTag,
            cTag: remoteManifest.cTag!,
            sha256Hash: manifestHash,
          },
        },
      ],
    };
    const items: SyncPlanItem[] = [
      {
        type: SyncActionType.Download,
        path: mainPath,
        remote: remoteMain,
        generationRestore: structuredClone(generationRestore),
      },
      {
        type: SyncActionType.Download,
        path: manifestPath,
        remote: remoteManifest,
        generationRestore: structuredClone(generationRestore),
      },
    ];
    const contentById = new Map([
      [remoteMain.driveId, mainContent],
      [remoteManifest.driveId, manifestContent],
    ]);
    const sourceById = new Map([
      [remoteMain.driveId, remoteMain],
      [remoteManifest.driveId, remoteManifest],
    ]);
    const downloadFile = vi.fn(async (
      _vaultName: string,
      _path: string,
      _downloadUrl: string | undefined,
      driveId: string,
    ) => contentById.get(driveId)?.slice(0) ?? new ArrayBuffer(0));
    const getDriveItemMetadataById = vi.fn(async (driveId: string) => {
      const source = sourceById.get(driveId);
      return source
        ? {
            id: source.driveId,
            name: source.path.slice(source.path.lastIndexOf("/") + 1),
            size: source.size,
            file: {},
            eTag: source.eTag,
            cTag: source.cTag,
            parentReference: { id: source.parentId },
          }
        : null;
    });
    const memory = makeMemoryAdapter({});
    const state = makeState([], []);
    const { executor } = makeExecutor({
      localEntries: [],
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, {
        downloadFile,
        getDriveItemMetadataById,
        readCommunityPluginLifecycleV1ById: vi.fn().mockResolvedValue({
          id: generationRestore.controlRecordId,
          eTag: "lifecycle-etag",
          content: JSON.stringify(lifecycleControl),
        }),
      }),
    });
    const result: SyncResult = {
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skippedLarge: 0,
      skippedIgnored: 0,
      errors: 0,
      authExpired: false,
      message: "",
    };
    const automaticPolicy = {
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    };
    const automaticMetrics: AutomaticHandlingMetrics = {
      policy: automaticPolicy,
      deleteLocal: { candidates: 0, completed: 0, failed: 0 },
      textMerge: {
        candidates: 0,
        completed: 0,
        keptManual: 0,
        failed: 0,
        cancelled: 0,
        manualReasons: {},
      },
      mergeRecovery: {
        records: 0,
        receiptCommitted: 0,
        notApplied: 0,
        remoteCommittedLocalRecovered: 0,
        remoteCommittedLocalPending: 0,
        unresolved: 0,
      },
      recoveryPendingAtEnd: { deleteLocal: 0, merge: 0 },
    };
    const internal = executor as unknown as {
      activeSyncScope: typeof SCOPE;
      lifecycle: { capture(): number };
      executePlan(
        plan: SyncPlan,
        result: SyncResult,
        callbacks: Record<string, never>,
        epoch: number,
        policy: typeof automaticPolicy,
        metrics: AutomaticHandlingMetrics,
        pluginPolicy: CommunityPluginSyncPolicyV1,
        generationRestores: ReadonlyMap<string, typeof generationProjection>,
      ): Promise<void>;
    };
    internal.activeSyncScope = SCOPE;
    await internal.executePlan(
      {
        items,
        lastTotalFiles: 0,
        confirmed: true,
        scope: SCOPE,
      },
      result,
      {},
      internal.lifecycle.capture(),
      automaticPolicy,
      automaticMetrics,
      {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
      new Map([["calendar", generationProjection]]),
    );

    expect(result).toMatchObject({ downloaded: 2, errors: 0, deferred: 0 });
    expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(mainContent),
    );
    expect(new Uint8Array(memory.binary.get(manifestPath)!)).toEqual(
      new Uint8Array(manifestContent),
    );
    expect(downloadFile.mock.calls.map((call) => call[1])).toEqual([
      remoteMain.path,
      remoteManifest.path,
    ]);
    expect(getDriveItemMetadataById).toHaveBeenCalledTimes(4);
    expect(state.beginMutationIntent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(state.beginMutationIntent).mock.calls.map(
      ([intent]) => intent,
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "download",
        path: mainPath,
        sourcePath: remoteMain.path,
        stateEffect: "local-only",
      }),
      expect.objectContaining({
        action: "download",
        path: manifestPath,
        sourcePath: remoteManifest.path,
        stateEffect: "local-only",
      }),
    ]));
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.remoteSnapshot).toEqual([]);

    const blockedMemory = makeMemoryAdapter({});
    const blockedState = makeState([], []);
    const { executor: blockedExecutor } = makeExecutor({
      localEntries: [],
      remoteEntries: [],
      remoteContent: null,
      adapter: blockedMemory.adapter,
      state: blockedState,
      oneDrive: makeOneDrive(null, {
        downloadFile,
        getDriveItemMetadataById: vi.fn(async (driveId: string) => {
          const source = sourceById.get(driveId);
          return source
            ? {
                id: source.driveId,
                name: source.path.slice(source.path.lastIndexOf("/") + 1),
                size: source.size,
                file: {},
                eTag: source.eTag,
                cTag: driveId === remoteMain.driveId
                  ? "generation-main-ctag-changed"
                  : source.cTag,
                parentReference: { id: source.parentId },
              }
            : null;
        }),
      }),
    });
    const blockedResult: SyncResult = {
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skippedLarge: 0,
      skippedIgnored: 0,
      errors: 0,
      authExpired: false,
      message: "",
    };
    const blockedInternal = blockedExecutor as unknown as typeof internal;
    blockedInternal.activeSyncScope = SCOPE;
    await blockedInternal.executePlan(
      {
        items,
        lastTotalFiles: 0,
        confirmed: true,
        scope: SCOPE,
      },
      blockedResult,
      {},
      blockedInternal.lifecycle.capture(),
      automaticPolicy,
      structuredClone(automaticMetrics),
      {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
    );
    expect(blockedResult).toMatchObject({ downloaded: 0, errors: 2 });
    expect(blockedMemory.binary.size).toBe(0);
    expect(blockedState.beginMutationIntent).not.toHaveBeenCalled();
    expect(blockedState.mutationLedger).toEqual([]);
    expect(blockedState.baseSnapshot).toEqual([]);
    expect(blockedState.remoteSnapshot).toEqual([]);
  });

  it("resumes a second-device sealed-generation join without trusting changed legacy files", async () => {
    const publisher: CommunityPluginParticipantIdentityV1 = {
      participantId: "publisher-device",
      incarnation: "publisher-incarnation",
    };
    const recipient: CommunityPluginParticipantIdentityV1 = {
      participantId: "recipient-device",
      incarnation: "recipient-incarnation",
    };
    let control = createCommunityPluginLifecycleControlV1(SCOPE);
    control = applyLifecycleCommand(
      control,
      { type: "register-participant", participant: publisher },
      "register-publisher",
      10,
    );
    control = applyLifecycleCommand(control, {
      type: "confirm-legacy-migration",
      actor: publisher,
      evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    }, "confirm-legacy-migration", 11);
    control = applyLifecycleCommand(control, {
      type: "join-plugin",
      participant: publisher,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "publisher-join-nonce",
      joinEvidence: "host-install",
    }, "join-publisher", 12);
    const grant = createCommunityPluginGenerationContentGrantV1({
      control,
      scope: SCOPE,
      participant: publisher,
      pluginId: "calendar",
    });
    expect(grant.status).toBe("ready");
    if (grant.status !== "ready") throw new Error("publisher grant missing");
    const mainContent = bytes("sealed-main");
    const pluginManifestContent = bytes(PLUGIN_MANIFEST_TEXT);
    const mainHash = await sha256Hex(mainContent);
    const pluginManifestHash = await sha256Hex(pluginManifestContent);
    const memberReceipts = [
      {
        fileName: "main.js" as const,
        objectPath: communityPluginGenerationObjectPathV1(grant.grant, mainHash),
        remoteId: "sealed-main-id",
        parentId: "sealed-object-parent",
        size: mainContent.byteLength,
        eTag: "sealed-main-etag",
        cTag: "sealed-main-ctag",
        sha256Hash: mainHash,
      },
      {
        fileName: "manifest.json" as const,
        objectPath: communityPluginGenerationObjectPathV1(
          grant.grant,
          pluginManifestHash,
        ),
        remoteId: "sealed-plugin-manifest-id",
        parentId: "sealed-object-parent",
        size: pluginManifestContent.byteLength,
        eTag: "sealed-plugin-manifest-etag",
        cTag: "sealed-plugin-manifest-ctag",
        sha256Hash: pluginManifestHash,
      },
    ];
    const canonicalManifest =
      await prepareCommunityPluginGenerationBundleManifestV1(
        grant.grant,
        memberReceipts,
      );
    const manifestObject = {
      objectPath: canonicalManifest.objectPath,
      remoteId: "sealed-canonical-manifest-id",
      parentId: "sealed-manifest-parent",
      size: canonicalManifest.bytes.byteLength,
      eTag: "sealed-canonical-manifest-etag",
      cTag: "sealed-canonical-manifest-ctag",
      sha256Hash: canonicalManifest.sha256Hash,
    };
    const publication = await createCommunityPluginBundlePublicationCommandV1({
      grant: grant.grant,
      control,
      prepared: canonicalManifest,
      manifestObject,
      operationId: "publish-calendar-generation",
      at: 13,
    });
    const published = reduceCommunityPluginLifecycleV1(control, publication);
    expect(published.status).toBe("applied");
    if (published.status !== "applied") throw new Error("publication failed");
    control = published.state;
    const publishedBundle = control.pluginsById.calendar.currentGeneration
      ?.publishedBundle;
    if (!publishedBundle) throw new Error("published bundle missing");
    control = applyLifecycleCommand(control, {
      type: "seal-plugin-legacy-authority",
      actor: publisher,
      pluginId: "calendar",
      generation: 1,
      publishedBundle,
    }, "seal-calendar-generation", 14);
    const sealedControl = structuredClone(control);
    const observedControl = applyLifecycleCommand(
      control,
      { type: "register-participant", participant: recipient },
      "register-recipient",
      15,
    );
    const joinedControl = applyLifecycleCommand(observedControl, {
      type: "join-plugin",
      participant: recipient,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "join-calendar-1",
      joinEvidence: "user-confirmed",
    }, "join-recipient", 16);
    const lifecycleObserver = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        source: "updated",
        state: observedControl,
        recordId: "lifecycle-record-id",
        recordETag: "lifecycle-observed-etag",
      }),
      getParticipantIdentity: vi.fn().mockReturnValue(recipient),
      joinPluginGeneration: vi.fn().mockResolvedValue({
        status: "ready",
        source: "updated",
        state: joinedControl,
        recordId: "lifecycle-record-id",
        recordETag: "lifecycle-joined-etag",
      }),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const pluginManifestPath = ".obsidian/plugins/calendar/manifest.json";
    const legacyMain = await remoteEntry(mainPath, bytes("changed-legacy-main"), {
      driveId: "legacy-main-id",
    });
    const legacyManifest = await remoteEntry(
      pluginManifestPath,
      pluginManifestContent,
      { driveId: "legacy-manifest-id" },
    );
    const memberById = new Map(memberReceipts.map((receipt) => [
      receipt.remoteId,
      receipt,
    ]));
    const contentById = new Map([
      [memberReceipts[0].remoteId, mainContent],
      [memberReceipts[1].remoteId, pluginManifestContent],
    ]);
    const downloadFile = vi.fn(async (
      _vaultName: string,
      _path: string,
      _downloadUrl: string | undefined,
      driveId: string,
    ) => contentById.get(driveId)?.slice(0) ?? new ArrayBuffer(0));
    const getDriveItemMetadataById = vi.fn(async (driveId: string) => {
      const source = memberById.get(driveId);
      return source
        ? {
            id: source.remoteId,
            name: source.objectPath.slice(source.objectPath.lastIndexOf("/") + 1),
            size: source.size,
            file: {},
            eTag: source.eTag,
            cTag: source.cTag,
            parentReference: { id: source.parentId },
          }
        : null;
    });
    const memory = makeMemoryAdapter({});
    const state = makeState([legacyMain, legacyManifest], []);
    const oneDrive = makeOneDrive(null, {
      readCommunityPluginLifecycleV1: vi.fn().mockResolvedValue({
        id: "lifecycle-record-id",
        eTag: "lifecycle-sealed-etag",
        content: JSON.stringify(sealedControl),
      }),
      readCommunityPluginLifecycleV1ById: vi.fn().mockResolvedValue({
        id: "lifecycle-record-id",
        eTag: "lifecycle-joined-etag",
        content: JSON.stringify(joinedControl),
      }),
      readCommunityPluginGenerationObjectV1ById: vi.fn()
        .mockRejectedValueOnce(new OneDriveError(
          OneDriveErrorType.NetworkError,
          "offline after generation join",
        ))
        .mockResolvedValue({
          id: manifestObject.remoteId,
          name: manifestObject.objectPath.slice(
            manifestObject.objectPath.lastIndexOf("/") + 1,
          ),
          parentId: manifestObject.parentId,
          size: manifestObject.size,
          eTag: manifestObject.eTag,
          cTag: manifestObject.cTag,
          content: canonicalManifest.bytes,
        }),
      getDelta: vi.fn().mockResolvedValue({
        value: completeRemoteItems([legacyMain, legacyManifest]),
        "@odata.deltaLink": "delta-token-next",
      }),
      downloadFile,
      getDriveItemMetadataById,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });
    const { executor } = makeExecutor({
      localEntries: [],
      remoteEntries: [legacyMain, legacyManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive,
      lifecycleObserver,
    });

    const authorization = joinAuthorization([legacyMain, legacyManifest]);
    expect(validateCommunityPluginJoinAuthorization(
      authorization,
      [legacyMain, legacyManifest],
      SCOPE,
    )).toEqual({ status: "valid" });
    const interrupted = await executor.run("manual", {}, false, undefined, {
      communityPluginJoinAuthorizations: [authorization],
    });

    expect(interrupted).toMatchObject({
      downloaded: 0,
      deferred: 1,
      errors: 0,
      communityPluginJoinBlocks: [{
        pluginId: "calendar",
        operationId: "join-calendar-1",
        reason: "catalog-unavailable",
      }],
    });
    expect(lifecycleObserver.joinPluginGeneration).toHaveBeenCalledTimes(1);
    expect(memory.binary.size).toBe(0);
    expect(state.beginMutationIntent).not.toHaveBeenCalled();

    const resumedLifecycleObserver = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        source: "updated",
        state: joinedControl,
        recordId: "lifecycle-record-id",
        recordETag: "lifecycle-joined-etag",
      }),
      getParticipantIdentity: vi.fn().mockReturnValue(recipient),
      joinPluginGeneration: vi.fn(),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const resumed = makeExecutor({
      localEntries: [],
      remoteEntries: [legacyMain, legacyManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive,
      lifecycleObserver: resumedLifecycleObserver,
    });
    const result = await resumed.executor.run("manual", {}, false, undefined, {
      communityPluginJoinAuthorizations: [authorization],
    });

    expect(result).toMatchObject({
      success: true,
      downloaded: 2,
      deferred: 0,
      errors: 0,
      communityPluginRestoresCompleted: { files: ["calendar"], data: [] },
      communityPluginRestoreGenerationByPluginId: { calendar: 1 },
    });
    expect(lifecycleObserver.observe).toHaveBeenCalledTimes(1);
    expect(lifecycleObserver.joinPluginGeneration).toHaveBeenCalledTimes(1);
    expect(resumedLifecycleObserver.observe).toHaveBeenCalledTimes(1);
    expect(resumedLifecycleObserver.joinPluginGeneration).not.toHaveBeenCalled();
    expect(oneDrive.readCommunityPluginLifecycleV1ById).toHaveBeenCalledWith(
      "lifecycle-record-id",
    );
    expect(downloadFile.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining(memberReceipts.map((item) => item.objectPath)),
    );
    expect(downloadFile.mock.calls.map((call) => call[3])).not.toContain(
      "legacy-main-id",
    );
    expect(memory.binary.has(mainPath)).toBe(true);
    expect(memory.binary.has(pluginManifestPath)).toBe(true);
    expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(mainContent),
    );
    expect(state.baseSnapshot).toEqual([]);
    expect(state.remoteSnapshot).toEqual([legacyMain, legacyManifest]);
    expect(vi.mocked(oneDrive.uploadFile)).not.toHaveBeenCalled();
    expect(vi.mocked(oneDrive.deleteItem)).not.toHaveBeenCalled();

    const offlineEdit = bytes("local-offline-edit");
    await memory.adapter.writeBinary(mainPath, offlineEdit);
    downloadFile.mockClear();
    const blocked = await resumed.executor.run("manual", {}, false, undefined, {
      communityPluginJoinAuthorizations: [authorization],
    });
    expect(blocked).toMatchObject({ downloaded: 0, errors: 2 });
    expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(offlineEdit),
    );
    expect(new Uint8Array(memory.binary.get(pluginManifestPath)!)).toEqual(
      new Uint8Array(pluginManifestContent),
    );
    expect(state.beginMutationIntent).toHaveBeenCalledTimes(2);

    state.getCommunityPluginParticipation = vi.fn().mockReturnValue({
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: true,
      pluginsById: {
        calendar: {
          pluginId: "calendar",
          phase: "participating",
          joinedGeneration: 1,
        },
      },
    });
    downloadFile.mockClear();
    vi.mocked(oneDrive.uploadFile).mockClear();
    const restoredRemoteMain = await remoteEntry(mainPath, mainContent, {
      driveId: "restored-fixed-main-id",
    });
    const restoredRemoteManifest = await remoteEntry(
      pluginManifestPath,
      pluginManifestContent,
      { driveId: "restored-fixed-manifest-id" },
    );
    state.baseSnapshot = [
      sharedBaseEntry(
        await localEntry(mainPath, mainContent),
        restoredRemoteMain,
      ),
      sharedBaseEntry(
        await localEntry(pluginManifestPath, pluginManifestContent),
        restoredRemoteManifest,
      ),
    ];
    state.remoteSnapshot = [restoredRemoteMain, restoredRemoteManifest];
    const ordinaryMain = bytes("post-restore-local-edit");
    const ordinaryManifest = pluginManifestContent;
    const ordinaryState = makeState(
      [restoredRemoteMain, restoredRemoteManifest],
      [
        sharedBaseEntry(
          await localEntry(mainPath, mainContent),
          restoredRemoteMain,
        ),
        sharedBaseEntry(
          await localEntry(pluginManifestPath, ordinaryManifest),
          restoredRemoteManifest,
        ),
      ],
      {
        getCommunityPluginParticipation: vi.fn().mockReturnValue({
          schemaVersion: 1,
          kind: "device-community-plugin-participation",
          scopeEnabled: true,
          pluginsById: {
            calendar: {
              pluginId: "calendar",
              phase: "participating",
              joinedGeneration: 1,
            },
          },
        }),
      },
    );
    const ordinaryMemory = makeMemoryAdapter({
      [mainPath]: ordinaryMain,
      [pluginManifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    const ordinaryUpload = vi.fn().mockResolvedValue({
      id: restoredRemoteMain.driveId,
      eTag: "ordinary-post-restore-etag",
      size: ordinaryMain.byteLength,
      parentReference: { id: restoredRemoteMain.parentId },
    });
    const ordinaryRemoteDownload = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === pluginManifestPath
      ? pluginManifestContent.slice(0)
      : new ArrayBuffer(0));
    const { executor: ordinaryExecutor } = makeExecutor({
      localEntries: [
        await localEntry(mainPath, ordinaryMain),
        await localEntry(pluginManifestPath, ordinaryManifest),
      ],
      remoteEntries: [restoredRemoteMain, restoredRemoteManifest],
      remoteContent: null,
      adapter: ordinaryMemory.adapter,
      state: ordinaryState,
      oneDrive: makeOneDrive(null, {
        uploadFile: ordinaryUpload,
        downloadFile: ordinaryRemoteDownload,
      }),
    });
    ordinaryMemory.binary.set(pluginManifestPath, pluginManifestContent.slice(0));
    const stable = await ordinaryExecutor.run("manual", {}, false);
    expect(stable).toMatchObject({
      success: true,
      uploaded: 1,
      downloaded: 0,
      errors: 0,
    });
    expect(ordinaryRemoteDownload).toHaveBeenCalledWith(
      "testVault",
      pluginManifestPath,
      restoredRemoteManifest.downloadUrl,
      restoredRemoteManifest.driveId,
      restoredRemoteManifest.size,
    );
    expect(ordinaryUpload).toHaveBeenCalled();
    expect(new Uint8Array(ordinaryMemory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(ordinaryMain),
    );
  });

  it("migrates a confirmed local legacy bundle and removes its fixed-path upload", async () => {
    const participant: CommunityPluginParticipantIdentityV1 = {
      participantId: "source-device",
      incarnation: "source-incarnation",
    };
    let initial = createCommunityPluginLifecycleControlV1(SCOPE);
    initial = applyLifecycleCommand(
      initial,
      { type: "register-participant", participant },
      "register-source",
      10,
    );
    initial = applyLifecycleCommand(initial, {
      type: "confirm-legacy-migration",
      actor: participant,
      evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    }, "confirm-legacy", 11);
    const joined = applyLifecycleCommand(initial, {
      type: "join-plugin",
      participant,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "source-join-nonce",
      joinEvidence: "user-confirmed",
    }, "join-source", 12);
    const grant = createCommunityPluginGenerationContentGrantV1({
      control: joined,
      scope: SCOPE,
      participant,
      pluginId: "calendar",
    });
    if (grant.status !== "ready") throw new Error("source grant missing");
    const mainContent = bytes("local-main");
    const manifestContent = bytes(PLUGIN_MANIFEST_TEXT);
    const mainHash = await sha256Hex(mainContent);
    const manifestHash = await sha256Hex(manifestContent);
    const receipts = [
      {
        fileName: "main.js" as const,
        objectPath: communityPluginGenerationObjectPathV1(grant.grant, mainHash),
        remoteId: "source-main-id",
        parentId: "source-objects-parent",
        size: mainContent.byteLength,
        eTag: "source-main-etag",
        cTag: "source-main-ctag",
        sha256Hash: mainHash,
      },
      {
        fileName: "manifest.json" as const,
        objectPath: communityPluginGenerationObjectPathV1(
          grant.grant,
          manifestHash,
        ),
        remoteId: "source-manifest-id",
        parentId: "source-objects-parent",
        size: manifestContent.byteLength,
        eTag: "source-manifest-etag",
        cTag: "source-manifest-ctag",
        sha256Hash: manifestHash,
      },
    ];
    const canonical = await prepareCommunityPluginGenerationBundleManifestV1(
      grant.grant,
      receipts,
    );
    const manifestObject = {
      objectPath: canonical.objectPath,
      remoteId: "source-canonical-manifest-id",
      parentId: "source-manifests-parent",
      size: canonical.bytes.byteLength,
      eTag: "source-canonical-etag",
      cTag: "source-canonical-ctag",
      sha256Hash: canonical.sha256Hash,
    };
    const publication = await createCommunityPluginBundlePublicationCommandV1({
      grant: grant.grant,
      control: joined,
      prepared: canonical,
      manifestObject,
      operationId: "publish-source-bundle",
      at: 13,
    });
    const published = reduceCommunityPluginLifecycleV1(joined, publication);
    if (published.status !== "applied") throw new Error("source publication failed");
    const publishedBundle = published.state.pluginsById.calendar
      .currentGeneration?.publishedBundle;
    if (!publishedBundle) throw new Error("source publication missing");
    const sealed = applyLifecycleCommand(published.state, {
      type: "seal-plugin-legacy-authority",
      actor: participant,
      pluginId: "calendar",
      generation: 1,
      publishedBundle,
    }, "seal-source", 14);
    const lifecycleObserver = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        source: "existing",
        state: initial,
        recordId: "lifecycle-record-id",
        recordETag: "lifecycle-initial-etag",
      }),
      getParticipantIdentity: vi.fn().mockReturnValue(participant),
      joinPluginGeneration: vi.fn().mockResolvedValue({
        status: "ready",
        source: "updated",
        state: joined,
        recordId: "lifecycle-record-id",
        recordETag: "lifecycle-joined-etag",
      }),
      migratePluginLegacyBundle: vi.fn().mockImplementation(async (
        _lifecycleTransport,
        _contentTransport,
        input: { revalidateSource?: () => Promise<boolean> },
      ) => input.revalidateSource && await input.revalidateSource()
        ? { status: "ready", state: sealed }
        : { status: "blocked", phase: "seal", reason: "source-changed" }),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const localEntries = [
      await localEntry(mainPath, mainContent),
      await localEntry(manifestPath, manifestContent),
    ];
    const memory = makeMemoryAdapter({
      [mainPath]: mainContent,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    memory.binary.set(manifestPath, manifestContent.slice(0));
    const participation = {
      schemaVersion: 1 as const,
      kind: "device-community-plugin-participation" as const,
      scopeEnabled: true,
      pluginsById: {
        calendar: { pluginId: "calendar", phase: "participating" as const },
      },
    };
    const state = makeState([], [], {
      getCommunityPluginParticipation: vi.fn(() => structuredClone(participation)),
    });
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => ({
      id: `ordinary-calendar-${path.split("/").at(-1)}-id`,
      eTag: `ordinary-calendar-${path.split("/").at(-1)}-etag`,
      size: content.byteLength,
      parentReference: { id: "plugin-folder-id" },
    }));
    const oneDrive = makeOneDrive(null, {
      readCommunityPluginLifecycleV1: vi.fn().mockResolvedValue({
        id: "lifecycle-record-id",
        eTag: "lifecycle-initial-etag",
        content: JSON.stringify(initial),
      }),
      readCommunityPluginLifecycleV1ById: vi.fn().mockResolvedValue({
        id: "lifecycle-record-id",
        eTag: "lifecycle-sealed-etag",
        content: JSON.stringify(sealed),
      }),
      uploadFile,
    });
    const { executor } = makeExecutor({
      localEntries,
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive,
      lifecycleObserver,
    });

    const result = await executor.run("manual");
    expect(result).toMatchObject({
      success: true,
      uploaded: 2,
      downloaded: 0,
      errors: 0,
    });
    expect(lifecycleObserver.joinPluginGeneration).not.toHaveBeenCalled();
    expect(lifecycleObserver.migratePluginLegacyBundle).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("reopens a cleaned plugin in the next generation without reading the deleted legacy manifest", async () => {
    const participant: CommunityPluginParticipantIdentityV1 = {
      participantId: "reopen-device",
      incarnation: "reopen-incarnation",
    };
    let control = createCommunityPluginLifecycleControlV1(SCOPE);
    control = applyLifecycleCommand(
      control,
      { type: "register-participant", participant },
      "register-reopen-device",
      10,
    );
    control = applyLifecycleCommand(control, {
      type: "confirm-legacy-migration",
      actor: participant,
      evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    }, "confirm-reopen-legacy", 11);
    control = applyLifecycleCommand(control, {
      type: "join-plugin",
      participant,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "reopen-generation-one",
      joinEvidence: "user-confirmed",
    }, "join-reopen-generation-one", 12);
    const mainContent = bytes("reopened-local-main");
    const manifestContent = bytes(PLUGIN_MANIFEST_TEXT);
    const publishGeneration = async (
      source: CommunityPluginLifecycleControlV1,
      suffix: string,
      at: number,
    ) => {
      const grant = createCommunityPluginGenerationContentGrantV1({
        control: source,
        scope: SCOPE,
        participant,
        pluginId: "calendar",
      });
      if (grant.status !== "ready") throw new Error("reopen grant missing");
      const mainHash = await sha256Hex(mainContent);
      const manifestHash = await sha256Hex(manifestContent);
      const receipts = [
        {
          fileName: "main.js" as const,
          objectPath: communityPluginGenerationObjectPathV1(grant.grant, mainHash),
          remoteId: `${suffix}-main-id`,
          parentId: `${suffix}-objects-parent`,
          size: mainContent.byteLength,
          eTag: `${suffix}-main-etag`,
          cTag: `${suffix}-main-ctag`,
          sha256Hash: mainHash,
        },
        {
          fileName: "manifest.json" as const,
          objectPath: communityPluginGenerationObjectPathV1(
            grant.grant,
            manifestHash,
          ),
          remoteId: `${suffix}-plugin-manifest-id`,
          parentId: `${suffix}-objects-parent`,
          size: manifestContent.byteLength,
          eTag: `${suffix}-plugin-manifest-etag`,
          cTag: `${suffix}-plugin-manifest-ctag`,
          sha256Hash: manifestHash,
        },
      ];
      const canonical = await prepareCommunityPluginGenerationBundleManifestV1(
        grant.grant,
        receipts,
      );
      const publication = await createCommunityPluginBundlePublicationCommandV1({
        grant: grant.grant,
        control: source,
        prepared: canonical,
        manifestObject: {
          objectPath: canonical.objectPath,
          remoteId: `${suffix}-canonical-manifest-id`,
          parentId: `${suffix}-manifests-parent`,
          size: canonical.bytes.byteLength,
          eTag: `${suffix}-canonical-etag`,
          cTag: `${suffix}-canonical-ctag`,
          sha256Hash: canonical.sha256Hash,
        },
        operationId: `publish-${suffix}`,
        at,
      });
      const published = reduceCommunityPluginLifecycleV1(source, publication);
      if (published.status !== "applied") throw new Error("reopen publish failed");
      return published.state;
    };

    control = await publishGeneration(control, "generation-one", 13);
    const generationOneBundle = control.pluginsById.calendar
      .currentGeneration?.publishedBundle;
    if (!generationOneBundle) throw new Error("generation one bundle missing");
    control = applyLifecycleCommand(control, {
      type: "seal-plugin-legacy-authority",
      actor: participant,
      pluginId: "calendar",
      generation: 1,
      publishedBundle: generationOneBundle,
    }, "seal-reopen-generation-one", 14);
    control = applyLifecycleCommand(control, {
      type: "exit-plugin",
      participant,
      pluginId: "calendar",
      generation: 1,
    }, "exit-reopen-generation-one", 15);
    control = applyLifecycleCommand(control, {
      type: "begin-close",
      actor: participant,
      pluginId: "calendar",
      generation: 1,
    }, "begin-close-reopen-generation-one", 16);
    control = applyLifecycleCommand(control, {
      type: "complete-close",
      actor: participant,
      pluginId: "calendar",
      generation: 1,
      cleanupReceiptDigest: "f".repeat(64),
    }, "complete-close-reopen-generation-one", 17);
    const closed = control;
    const joined = applyLifecycleCommand(closed, {
      type: "join-plugin",
      participant,
      pluginId: "calendar",
      targetGeneration: 2,
      joinNonce: "reopen-generation-two",
      joinEvidence: "user-confirmed",
      observedClosedRevision: closed.revision,
    }, "join-reopen-generation-two", 18);
    const republished = await publishGeneration(joined, "generation-two", 19);
    expect(republished.pluginsById.calendar.legacyAuthoritySeal?.generation)
      .toBe(1);
    expect(republished.pluginsById.calendar.currentGeneration).toMatchObject({
      generation: 2,
      phase: "open",
      publishedBundle: { publicationRevision: 1 },
    });

    const lifecycleObserver = {
      observe: vi.fn().mockResolvedValue({
        status: "ready",
        source: "existing",
        state: closed,
        recordId: "reopen-lifecycle-record-id",
        recordETag: "reopen-closed-etag",
      }),
      getParticipantIdentity: vi.fn().mockReturnValue(participant),
      joinPluginGeneration: vi.fn().mockResolvedValue({
        status: "ready",
        source: "updated",
        state: joined,
        recordId: "reopen-lifecycle-record-id",
        recordETag: "reopen-joined-etag",
      }),
      migratePluginLegacyBundle: vi.fn().mockResolvedValue({
        status: "ready",
        state: republished,
      }),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const localEntries = [
      await localEntry(mainPath, mainContent),
      await localEntry(manifestPath, manifestContent),
    ];
    const memory = makeMemoryAdapter({
      [mainPath]: mainContent,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    memory.binary.set(manifestPath, manifestContent.slice(0));
    const state = makeState([], [], {
      getCommunityPluginParticipation: vi.fn(() => ({
        schemaVersion: 1 as const,
        kind: "device-community-plugin-participation" as const,
        scopeEnabled: true,
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "participating" as const },
        },
      })),
    });
    const readGenerationObject = vi.fn().mockRejectedValue(
      new Error("the deleted generation-one manifest must not be read"),
    );
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => ({
      id: `ordinary-calendar-${path.split("/").at(-1)}-id`,
      eTag: `ordinary-calendar-${path.split("/").at(-1)}-etag`,
      size: content.byteLength,
      parentReference: { id: "plugin-folder-id" },
    }));
    const oneDrive = makeOneDrive(null, {
      readCommunityPluginLifecycleV1: vi.fn().mockResolvedValue({
        id: "reopen-lifecycle-record-id",
        eTag: "reopen-closed-etag",
        content: JSON.stringify(closed),
      }),
      readCommunityPluginLifecycleV1ById: vi.fn().mockResolvedValue({
        id: "reopen-lifecycle-record-id",
        eTag: "reopen-published-etag",
        content: JSON.stringify(republished),
      }),
      readCommunityPluginGenerationObjectV1ById: readGenerationObject,
      uploadFile,
    });
    const { executor } = makeExecutor({
      localEntries,
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive,
      lifecycleObserver,
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 2,
      downloaded: 0,
      errors: 0,
    });
    expect(lifecycleObserver.joinPluginGeneration).not.toHaveBeenCalled();
    expect(lifecycleObserver.migratePluginLegacyBundle).not.toHaveBeenCalled();
    expect(readGenerationObject).not.toHaveBeenCalled();
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("keeps an exited generation open and untouched during ordinary sync", async () => {
    const storage = makeVaultLocalStorage();
    const vaultInstanceId = "d".repeat(32);
    const identity = loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceId,
      10,
    )!;
    const participant = identity.participant;
    let lifecycleState = createCommunityPluginLifecycleControlV1(SCOPE);
    lifecycleState = applyLifecycleCommand(
      lifecycleState,
      { type: "register-participant", participant },
      "register-cleanup-device",
      10,
    );
    lifecycleState = applyLifecycleCommand(lifecycleState, {
      type: "confirm-legacy-migration",
      actor: participant,
      evidence: "user-confirmed-legacy-devices-upgraded-or-retired",
    }, "confirm-cleanup-legacy", 11);
    lifecycleState = applyLifecycleCommand(lifecycleState, {
      type: "join-plugin",
      participant,
      pluginId: "calendar",
      targetGeneration: 1,
      joinNonce: "cleanup-join",
      joinEvidence: "user-confirmed",
    }, "join-cleanup-device", 12);
    const grant = createCommunityPluginGenerationContentGrantV1({
      control: lifecycleState,
      scope: SCOPE,
      participant,
      pluginId: "calendar",
    });
    if (grant.status !== "ready") throw new Error("cleanup grant missing");
    const mainContent = bytes("cleanup-main");
    const manifestContent = bytes(PLUGIN_MANIFEST_TEXT);
    const mainHash = await sha256Hex(mainContent);
    const manifestHash = await sha256Hex(manifestContent);
    const members = [
      {
        fileName: "main.js" as const,
        objectPath: communityPluginGenerationObjectPathV1(grant.grant, mainHash),
        remoteId: "cleanup-main-id",
        parentId: "cleanup-objects-parent",
        size: mainContent.byteLength,
        eTag: "cleanup-main-etag",
        cTag: "cleanup-main-ctag",
        sha256Hash: mainHash,
      },
      {
        fileName: "manifest.json" as const,
        objectPath: communityPluginGenerationObjectPathV1(
          grant.grant,
          manifestHash,
        ),
        remoteId: "cleanup-plugin-manifest-id",
        parentId: "cleanup-objects-parent",
        size: manifestContent.byteLength,
        eTag: "cleanup-plugin-manifest-etag",
        cTag: "cleanup-plugin-manifest-ctag",
        sha256Hash: manifestHash,
      },
    ];
    const canonical = await prepareCommunityPluginGenerationBundleManifestV1(
      grant.grant,
      members,
    );
    const manifestObject = {
      objectPath: canonical.objectPath,
      remoteId: "cleanup-canonical-manifest-id",
      parentId: "cleanup-manifests-parent",
      size: canonical.bytes.byteLength,
      eTag: "cleanup-canonical-etag",
      cTag: "cleanup-canonical-ctag",
      sha256Hash: canonical.sha256Hash,
    };
    const publication = await createCommunityPluginBundlePublicationCommandV1({
      grant: grant.grant,
      control: lifecycleState,
      prepared: canonical,
      manifestObject,
      operationId: "publish-cleanup-bundle",
      at: 13,
    });
    const published = reduceCommunityPluginLifecycleV1(
      lifecycleState,
      publication,
    );
    if (published.status !== "applied") throw new Error("cleanup publish failed");
    const publishedBundle = published.state.pluginsById.calendar
      .currentGeneration?.publishedBundle;
    if (!publishedBundle) throw new Error("cleanup publication missing");
    lifecycleState = applyLifecycleCommand(published.state, {
      type: "seal-plugin-legacy-authority",
      actor: participant,
      pluginId: "calendar",
      generation: 1,
      publishedBundle,
    }, "seal-cleanup-bundle", 14);

    const generationObjects = new Map([
      [members[0].remoteId, {
        id: members[0].remoteId,
        name: members[0].objectPath.split("/").at(-1)!,
        parentId: members[0].parentId,
        size: members[0].size,
        eTag: members[0].eTag,
        cTag: members[0].cTag,
        content: mainContent,
      }],
      [members[1].remoteId, {
        id: members[1].remoteId,
        name: members[1].objectPath.split("/").at(-1)!,
        parentId: members[1].parentId,
        size: members[1].size,
        eTag: members[1].eTag,
        cTag: members[1].cTag,
        content: manifestContent,
      }],
      [manifestObject.remoteId, {
        id: manifestObject.remoteId,
        name: manifestObject.objectPath.split("/").at(-1)!,
        parentId: manifestObject.parentId,
        size: manifestObject.size,
        eTag: manifestObject.eTag,
        cTag: manifestObject.cTag,
        content: canonical.bytes,
      }],
    ]);
    let lifecycleObject = {
      id: "cleanup-lifecycle-id",
      eTag: "cleanup-lifecycle-etag-0",
      content: JSON.stringify(lifecycleState),
    };
    let lifecycleWrite = 0;
    const updateLifecycle = vi.fn(async (
      id: string,
      eTag: string,
      content: string,
    ) => {
      if (id !== lifecycleObject.id || eTag !== lifecycleObject.eTag) {
        throw new Error("lifecycle CAS mismatch");
      }
      lifecycleWrite++;
      lifecycleObject = {
        id,
        eTag: `cleanup-lifecycle-etag-${lifecycleWrite}`,
        content,
      };
      return { id, eTag: lifecycleObject.eTag };
    });
    const initialEnablement = bytes('["calendar"]');
    let remoteEnablement = initialEnablement.slice(0);
    const localCommunity = await localEntry(COMMUNITY_PATH, initialEnablement);
    const remoteCommunity = await remoteEntry(
      COMMUNITY_PATH,
      remoteEnablement,
      {
        driveId: "cleanup-enablement-id",
        eTag: "cleanup-enablement-etag-0",
      },
    );
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: initialEnablement });
    const deleteItem = vi.fn(async (
      _vaultName: string,
      _path: string,
      eTag: string,
      id: string,
    ) => {
      const object = generationObjects.get(id);
      if (!object || object.eTag !== eTag) throw new Error("cleanup CAS mismatch");
      generationObjects.delete(id);
    });
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => {
      if (path !== COMMUNITY_PATH) throw new Error("unexpected upload");
      remoteEnablement = content.slice(0);
      remoteCommunity.size = content.byteLength;
      remoteCommunity.sha256Hash = await sha256Hex(content);
      remoteCommunity.eTag = "cleanup-enablement-etag-1";
      return {
        id: remoteCommunity.driveId,
        eTag: remoteCommunity.eTag,
        size: content.byteLength,
        parentReference: { id: remoteCommunity.parentId },
      };
    });
    const oneDrive = makeOneDrive(remoteEnablement, {
      downloadFile: vi.fn(async (
        _vaultName: string,
        path: string,
      ) => path === COMMUNITY_PATH
        ? remoteEnablement.slice(0)
        : new ArrayBuffer(0)),
      uploadFile,
      readCommunityPluginLifecycleV1: vi.fn(async () =>
        structuredClone(lifecycleObject)),
      readCommunityPluginLifecycleV1ById: vi.fn(async (id: string) => {
        if (id !== lifecycleObject.id) throw new Error("lifecycle missing");
        return structuredClone(lifecycleObject);
      }),
      updateCommunityPluginLifecycleV1: updateLifecycle,
      readCommunityPluginGenerationObjectV1ById: vi.fn(async (id: string) => {
        const object = generationObjects.get(id);
        if (!object) throw new Error("generation object missing");
        return structuredClone(object);
      }),
      getDriveItemMetadataById: vi.fn(async (id: string) => {
        const object = generationObjects.get(id);
        return object
          ? {
              id: object.id,
              name: object.name,
              size: object.size,
              eTag: object.eTag,
              cTag: object.cTag,
              file: {},
              parentReference: { id: object.parentId },
            }
          : null;
      }),
      deleteItem,
    });
    const participation = {
      schemaVersion: 1 as const,
      kind: "device-community-plugin-participation" as const,
      scopeEnabled: false,
      pluginsById: {
        calendar: { pluginId: "calendar", phase: "excluded" as const },
      },
    };
    const state = makeState(
      [remoteCommunity],
      [],
      {
        getCommunityPluginParticipation: vi.fn(() =>
          structuredClone(participation)),
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: true },
          pending: [],
        }),
      },
      REMOTE_FOLDERS.slice(0, 2),
    );
    const lifecycleObserver = new CommunityPluginLifecycleDeviceObserverV1(
      storage,
      vaultInstanceId,
    );
    const { executor } = makeExecutor({
      localEntries: [localCommunity],
      remoteEntries: [remoteCommunity],
      remoteContent: remoteEnablement,
      adapter: memory.adapter,
      state,
      oneDrive,
      lifecycleObserver,
      policy: {
        version: 1,
        files: { mode: "none", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      localFolders: REMOTE_FOLDERS.slice(0, 2).map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteFolders: REMOTE_FOLDERS.slice(0, 2),
    });

    await executor.run(
      "manual",
      {},
      false,
      undefined,
      { readOnlyPreview: true },
    );
    expect(updateLifecycle).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(JSON.parse(lifecycleObject.content).pluginsById.calendar
      .currentGeneration.phase).toBe("open");

    const prepared = await executor.run("manual");
    expect(prepared).toMatchObject({ success: true, errors: 0 });
    expect(JSON.parse(lifecycleObject.content).pluginsById.calendar
      .currentGeneration.phase).toBe("open");
    expect(deleteItem).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(memory.binary.get(COMMUNITY_PATH)!))
      .toBe('["calendar"]');

    const completed = await executor.run("manual");
    expect(completed).toMatchObject({ success: true, errors: 0 });
    expect(new TextDecoder().decode(memory.binary.get(COMMUNITY_PATH)!))
      .toBe('["calendar"]');
    expect(new TextDecoder().decode(remoteEnablement)).toBe('["calendar"]');
    expect(deleteItem).not.toHaveBeenCalled();
    expect(generationObjects.size).toBe(3);
    expect(JSON.parse(lifecycleObject.content).pluginsById.calendar
      .currentGeneration.phase).toBe("open");

    localCommunity.size = 3;
    localCommunity.hash = await sha256Hex(bytes("[]\n"));
    uploadFile.mockClear();
    deleteItem.mockClear();
    const stable = await executor.run("manual");
    expect(stable).toMatchObject({ success: true, errors: 0 });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("keeps ordinary file transfer independent from retired lifecycle housekeeping", async () => {
    const storage = makeVaultLocalStorage();
    const vaultInstanceId = "e".repeat(32);
    loadOrCreateCommunityPluginLifecycleDeviceIdentityV1(
      storage,
      vaultInstanceId,
      10,
    );
    const enablement = bytes('["calendar"]');
    const noteContent = bytes("ordinary-note");
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const localNote = await localEntry("ordinary.md", noteContent);
    const memory = makeMemoryAdapter({
      [COMMUNITY_PATH]: enablement,
      "ordinary.md": noteContent,
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: "ordinary-note-id",
      eTag: "ordinary-note-etag",
      size: noteContent.byteLength,
      parentReference: { id: SCOPE.filesRootId },
    });
    const readLifecycle = vi.fn().mockRejectedValue(
      new Error("lifecycle temporarily unavailable"),
    );
    const state = makeState(
      [remoteCommunity],
      [],
      {
        getCommunityPluginParticipation: vi.fn(() => ({
          schemaVersion: 1 as const,
          kind: "device-community-plugin-participation" as const,
          scopeEnabled: false,
          pluginsById: {
            calendar: { pluginId: "calendar", phase: "excluded" as const },
          },
        })),
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: true },
          pending: [{
            pluginId: "calendar",
            localEnabled: true,
            remoteEnabled: false,
          }],
        }),
      },
      REMOTE_FOLDERS.slice(0, 2),
    );
    const { executor } = makeExecutor({
      localEntries: [localCommunity, localNote],
      remoteEntries: [remoteCommunity],
      remoteContent: enablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(enablement, {
        uploadFile,
        readCommunityPluginLifecycleV1: readLifecycle,
      }),
      lifecycleObserver: new CommunityPluginLifecycleDeviceObserverV1(
        storage,
        vaultInstanceId,
      ),
      policy: {
        version: 1,
        files: { mode: "none", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      localFolders: REMOTE_FOLDERS.slice(0, 2).map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteFolders: REMOTE_FOLDERS.slice(0, 2),
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({ success: true, uploaded: 1, errors: 0 });
    expect(result.attention).toBeUndefined();
    expect(result.message).not.toBe(
      "result.communityPluginEnablementDecisionRequired",
    );
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      "ordinary.md",
      noteContent,
      undefined,
      undefined,
      undefined,
    );
    expect(readLifecycle).not.toHaveBeenCalled();
  });

  it("keeps a device-excluded plugin in cloud without executor participation inference", async () => {
    const localEnablement = bytes("[]");
    const remoteEnablement = bytes("[\"calendar\"]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, remoteEnablement);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const remoteManifest = await remoteEntry(
      manifestPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const baseEntries: BaseFileEntry[] = [
      {
        path: mainPath,
        size: remoteMain.size,
        hash: remoteMain.sha256Hash!,
        eTag: remoteMain.eTag,
      },
      {
        path: manifestPath,
        size: remoteManifest.size,
        hash: remoteManifest.sha256Hash!,
        eTag: remoteManifest.eTag,
      },
    ];
    const localCommunity = await localEntry(COMMUNITY_PATH, localEnablement);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localEnablement });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const lifecycleObserver = {
      observe: vi.fn(),
      joinPluginGeneration: vi.fn(),
      migratePluginLegacyBundle: vi.fn(),
      sealPluginLegacyAuthority: vi.fn(),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const state = makeState(
      [remoteCommunity, remoteMain, remoteManifest],
      baseEntries,
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: true },
          pending: [],
        }),
      },
    );
    const { executor } = makeExecutor({
      localEntries: [localCommunity],
      remoteEntries: [remoteCommunity, remoteMain, remoteManifest],
      remoteContent: remoteEnablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(remoteEnablement, {
        deleteItem,
        uploadFile,
        downloadFile: vi.fn(async (
          _vaultName: string,
          path: string,
        ) => path === COMMUNITY_PATH ? remoteEnablement : new ArrayBuffer(0)),
      }),
      lifecycleObserver,
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      localFolders: REMOTE_FOLDERS
        .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
        .map((folder) => ({ path: folder.path, mtime: 1 })),
      shouldSyncFolderPath: (path) =>
        path !== ".obsidian/plugins/calendar",
    });
    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.deferred).toBe(0);
    expect(result.communityPluginLocalIgnores).toBeUndefined();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.reconcilePendingIssues).toHaveBeenLastCalledWith(
      [],
      expect.any(Set),
    );
    expect(lifecycleObserver.observe).not.toHaveBeenCalled();
    expect(lifecycleObserver.joinPluginGeneration).not.toHaveBeenCalled();
    expect(lifecycleObserver.migratePluginLegacyBundle).not.toHaveBeenCalled();
    expect(lifecycleObserver.sealPluginLegacyAuthority).not.toHaveBeenCalled();
  });

  it("keeps an ordinary V2 upload for a participating generation plugin after local code changes", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const oldMain = bytes("old-main");
    const changedMain = bytes("changed-local-main");
    const manifest = bytes(PLUGIN_MANIFEST_TEXT);
    const remoteMain = await remoteEntry(mainPath, oldMain);
    const remoteManifest = await remoteEntry(manifestPath, manifest);
    const localMain = await localEntry(mainPath, changedMain);
    const localManifest = await localEntry(manifestPath, manifest);
    const state = makeState(
      [remoteMain, remoteManifest],
      [
        sharedBaseEntry(await localEntry(mainPath, oldMain), remoteMain),
        sharedBaseEntry(localManifest, remoteManifest),
      ],
      {
        getCommunityPluginParticipation: vi.fn().mockReturnValue({
          schemaVersion: 1,
          kind: "device-community-plugin-participation",
          scopeEnabled: true,
          pluginsById: {
            calendar: {
              pluginId: "calendar",
              phase: "participating",
              joinedGeneration: 1,
            },
          },
        }),
      },
    );
    const memory = makeMemoryAdapter({
      [mainPath]: changedMain,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: remoteMain.driveId,
      eTag: "etag:changed-local-main",
      size: changedMain.byteLength,
      parentReference: { id: remoteMain.parentId },
    });
    const lifecycleObserver = {
      observe: vi.fn(),
      joinPluginGeneration: vi.fn(),
      migratePluginLegacyBundle: vi.fn(),
      sealPluginLegacyAuthority: vi.fn(),
    } as unknown as NonNullable<ConstructorParameters<typeof SyncExecutor>[11]>;
    const { executor } = makeExecutor({
      localEntries: [localMain, localManifest],
      remoteEntries: [remoteMain, remoteManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, {
        uploadFile,
        downloadFile: vi.fn(async (
          _vaultName: string,
          path: string,
        ) => path === manifestPath ? manifest : new ArrayBuffer(0)),
      }),
      lifecycleObserver,
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      mainPath,
      changedMain,
      undefined,
      expect.anything(),
      expect.anything(),
    );
    expect(lifecycleObserver.observe).not.toHaveBeenCalled();
    expect(lifecycleObserver.joinPluginGeneration).not.toHaveBeenCalled();
    expect(lifecycleObserver.migratePluginLegacyBundle).not.toHaveBeenCalled();
    expect(lifecycleObserver.sealPluginLegacyAuthority).not.toHaveBeenCalled();
  });

  it("keeps an ordinary V2 download for a participating generation plugin after remote code changes", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const oldMain = bytes("old-main");
    const changedMain = bytes("changed-remote-main");
    const manifest = bytes(PLUGIN_MANIFEST_TEXT);
    const remoteMain = await remoteEntry(mainPath, changedMain);
    const remoteManifest = await remoteEntry(manifestPath, manifest);
    const localMain = await localEntry(mainPath, oldMain);
    const localManifest = await localEntry(manifestPath, manifest);
    const state = makeState(
      [remoteMain, remoteManifest],
      [
        sharedBaseEntry(localMain, await remoteEntry(mainPath, oldMain)),
        sharedBaseEntry(localManifest, remoteManifest),
      ],
      {
        getCommunityPluginParticipation: vi.fn().mockReturnValue({
          schemaVersion: 1,
          kind: "device-community-plugin-participation",
          scopeEnabled: true,
          pluginsById: {
            calendar: {
              pluginId: "calendar",
              phase: "participating",
              joinedGeneration: 1,
            },
          },
        }),
      },
    );
    const memory = makeMemoryAdapter({
      [mainPath]: oldMain,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === mainPath ? changedMain : manifest);
    const { executor } = makeExecutor({
      localEntries: [localMain, localManifest],
      remoteEntries: [remoteMain, remoteManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { downloadFile }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      mainPath,
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(memory.binary.get(mainPath)).toEqual(changedMain);
  });

  it("keeps a two-sided participating generation change in the ordinary conflict path", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const oldMain = bytes("old-main");
    const changedLocalMain = bytes("changed-local-main");
    const changedRemoteMain = bytes("changed-remote-main");
    const manifest = bytes(PLUGIN_MANIFEST_TEXT);
    const remoteMain = await remoteEntry(mainPath, changedRemoteMain);
    const remoteManifest = await remoteEntry(manifestPath, manifest);
    const localMain = await localEntry(mainPath, changedLocalMain);
    const localManifest = await localEntry(manifestPath, manifest);
    const oldRemoteMain = await remoteEntry(mainPath, oldMain);
    const state = makeState(
      [remoteMain, remoteManifest],
      [
        sharedBaseEntry(await localEntry(mainPath, oldMain), oldRemoteMain),
        sharedBaseEntry(localManifest, remoteManifest),
      ],
      {
        getCommunityPluginParticipation: vi.fn().mockReturnValue({
          schemaVersion: 1,
          kind: "device-community-plugin-participation",
          scopeEnabled: true,
          pluginsById: {
            calendar: {
              pluginId: "calendar",
              phase: "participating",
              joinedGeneration: 1,
            },
          },
        }),
      },
    );
    const memory = makeMemoryAdapter({
      [mainPath]: changedLocalMain,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === mainPath ? changedRemoteMain : manifest);
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [localMain, localManifest],
      remoteEntries: [remoteMain, remoteManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { downloadFile, uploadFile }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.conflicts).toBeGreaterThan(0);
    expect(result.conflicts).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(memory.binary.get(mainPath)).toEqual(changedLocalMain);
  });

  it("keeps cloud plugin code when this device exits participation", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const main = bytes("cloud-main");
    const manifest = bytes(PLUGIN_MANIFEST_TEXT);
    const remoteMain = await remoteEntry(mainPath, main);
    const remoteManifest = await remoteEntry(manifestPath, manifest);
    const localMain = await localEntry(mainPath, main);
    const localManifest = await localEntry(manifestPath, manifest);
    const state = makeState(
      [remoteMain, remoteManifest],
      [
        sharedBaseEntry(localMain, remoteMain),
        sharedBaseEntry(localManifest, remoteManifest),
      ],
      {
        getCommunityPluginParticipation: vi.fn().mockReturnValue({
          schemaVersion: 1,
          kind: "device-community-plugin-participation",
          scopeEnabled: false,
          pluginsById: {
            calendar: {
              pluginId: "calendar",
              phase: "excluded",
              joinedGeneration: 1,
            },
          },
        }),
      },
    );
    const memory = makeMemoryAdapter({
      [mainPath]: main,
      [manifestPath]: manifest,
    });
    const deleteItem = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [localMain, localManifest],
      remoteEntries: [remoteMain, remoteManifest],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { deleteItem }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(memory.binary.get(mainPath)).toEqual(main);
    expect(memory.binary.get(manifestPath)).toEqual(manifest);
  });

  it("does not download a remote manifest solely for desktop inventory display", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const manifestPath = ".obsidian/plugins/calendar/manifest.json";
      const mainPath = ".obsidian/plugins/calendar/main.js";
      const manifestBytes = bytes(JSON.stringify({
        id: "calendar",
        name: "Calendar",
        version: "2.0.0",
        minAppVersion: "1.5.0",
      }));
      const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
      const remoteMain = await remoteEntry(mainPath, bytes("main"));
      const downloadFile = vi.fn().mockResolvedValue(manifestBytes);
      const memory = makeMemoryAdapter({});
      const { executor, state } = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS.slice(0, 2).map((folder) => ({
          path: folder.path,
          mtime: 1,
        })),
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: memory.adapter,
        oneDrive: makeOneDrive(null, { downloadFile }),
        policy: {
          version: 1,
          files: { mode: "selected", pluginIds: [] },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const result = await executor.run("manual");

      expect(result).toMatchObject({
        success: true,
        downloaded: 0,
        errors: 0,
      });
      expect(downloadFile).not.toHaveBeenCalled();
      expect(state.getCommunityPluginManifestObservations()).toEqual([]);
      expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("keeps a partial remote-only excluded bundle outside the executor plan", async () => {
    const localEnablement = bytes("[]");
    const remoteEnablement = bytes("[\"calendar\"]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localCommunity = await localEntry(COMMUNITY_PATH, localEnablement);
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, remoteEnablement);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === COMMUNITY_PATH) return remoteEnablement;
      throw new Error(`unexpected bundle download: ${path}`);
    });
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localEnablement });
    const state = makeState([remoteCommunity, remoteMain], [], {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { calendar: true },
        pending: [],
      }),
    });
    const { executor } = makeExecutor({
      localEntries: [localCommunity],
      localFolders: REMOTE_FOLDERS.slice(0, 2).map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteEntries: [remoteCommunity, remoteMain],
      remoteContent: remoteEnablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(remoteEnablement, { downloadFile }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      downloaded: 0,
      errors: 0,
    });
    expect(downloadFile.mock.calls.some((call) => call[1] === mainPath)).toBe(false);
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(state.reconcilePendingIssues).toHaveBeenLastCalledWith(
      [],
      expect.any(Set),
    );
  });

  it("does not enter a display-only remote read path for an ignored plugin", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestBytes = bytes(JSON.stringify({
      id: "calendar",
      name: "Calendar",
      version: "2.0.0",
    }));
    const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const downloadFile = vi.fn().mockRejectedValue(
      new Error("manifest read failed"),
    );
    const warn = vi.fn();
    const memory = makeMemoryAdapter({});
    const { executor, state } = makeExecutor({
      localEntries: [],
      localFolders: REMOTE_FOLDERS.slice(0, 2).map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteEntries: [remoteManifest, remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      oneDrive: makeOneDrive(null, { downloadFile }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      diag: {
        log: vi.fn(),
        warn,
        error: vi.fn(),
        isEnabled: vi.fn().mockReturnValue(false),
      } as never,
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({ success: true, downloaded: 0, errors: 0 });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.getCommunityPluginManifestObservations()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("does not turn a source-bound move hint into executor participation state", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const localEnablement = bytes("[]");
      const remoteEnablement = bytes("[\"calendar\"]");
      const mainPath = ".obsidian/plugins/calendar/main.js";
      const manifestPath = ".obsidian/plugins/calendar/manifest.json";
      const remoteCommunity = await remoteEntry(COMMUNITY_PATH, remoteEnablement);
      const remoteMain = await remoteEntry(mainPath, bytes("main"));
      const remoteManifest = await remoteEntry(
        manifestPath,
        bytes(PLUGIN_MANIFEST_TEXT),
      );
      const localCommunity = await localEntry(COMMUNITY_PATH, localEnablement);
      const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localEnablement });
      const deleteItem = vi.fn();
      const uploadFile = vi.fn();
      const downloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
      ) => {
        if (path === COMMUNITY_PATH) return remoteEnablement;
        if (path === manifestPath) return bytes(PLUGIN_MANIFEST_TEXT);
        return new ArrayBuffer(0);
      });
      const state = makeState(
        [remoteCommunity, remoteMain, remoteManifest],
        [],
        {
          localFolderMoveHints: [{
            version: 1,
            scope: SCOPE,
            remoteId: "plugin-folder-id",
            fromPath: ".obsidian/plugins/calendar",
            toPath: ".trash/.obsidian/plugins/calendar",
            observedAt: 1,
          }],
          getCommunityPluginEnablementState: vi.fn().mockReturnValue({
            version: 1,
            scope: SCOPE,
            anchors: { calendar: true },
            pending: [],
          }),
        },
      );
      const { executor } = makeExecutor({
        localEntries: [localCommunity],
        remoteEntries: [remoteCommunity, remoteMain, remoteManifest],
        remoteContent: remoteEnablement,
        adapter: memory.adapter,
        state,
        oneDrive: makeOneDrive(remoteEnablement, {
          deleteItem,
          uploadFile,
          downloadFile,
        }),
        policy: {
          version: 1,
          files: { mode: "selected", pluginIds: [] },
          data: { mode: "none", pluginIds: [] },
        },
        localFolders: REMOTE_FOLDERS
          .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
          .map((folder) => ({ path: folder.path, mtime: 1 })),
        shouldSyncFolderPath: (path) => !path.startsWith(".trash/"),
      });

      const result = await executor.run("manual");

      expect(result.success).toBe(true);
      expect(result.deferred).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.communityPluginLocalIgnores).toBeUndefined();
      expect(deleteItem).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
      expect(memory.adapter.remove).not.toHaveBeenCalled();
      expect(state.reconcilePendingIssues).toHaveBeenLastCalledWith(
        [],
        expect.any(Set),
      );
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("converges an ignored plugin bundle with a residual root folder across repeated rounds", async () => {
    const enablement = bytes("[]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const remoteManifest = await remoteEntry(
      manifestPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const baseEntries: BaseFileEntry[] = [
      {
        path: mainPath,
        size: remoteMain.size,
        hash: remoteMain.sha256Hash!,
        eTag: remoteMain.eTag,
      },
      {
        path: manifestPath,
        size: remoteManifest.size,
        hash: remoteManifest.sha256Hash!,
        eTag: remoteManifest.eTag,
      },
    ];
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const localManifest = await localEntry(
      manifestPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const localEntries = [localCommunity];
    const localFolders = REMOTE_FOLDERS
      .map((folder) => ({ path: folder.path, mtime: 1 }));
    let participating = false;
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: enablement });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === COMMUNITY_PATH) return enablement;
      if (path === mainPath) return bytes("main");
      if (path === manifestPath) return bytes(PLUGIN_MANIFEST_TEXT);
      return new ArrayBuffer(0);
    });
    const state = makeState(
      [remoteCommunity, remoteMain, remoteManifest],
      baseEntries,
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: false },
          pending: [],
        }),
      },
    );
    const { executor } = makeExecutor({
      localEntries,
      localFolders,
      remoteEntries: [remoteCommunity, remoteMain, remoteManifest],
      remoteContent: enablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        downloadFile,
      }),
      policy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          ignoredPluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
      shouldSyncFolderPath: (path) =>
        participating || path !== ".obsidian/plugins/calendar",
    });

    const first = await executor.run("manual");
    const second = await executor.run("manual");

    for (const result of [first, second]) {
      expect(result.success).toBe(true);
      expect(result.deferred).toBe(0);
      expect(result.errors).toBe(0);
    }
    expect(state.reconcilePendingIssues).toHaveBeenLastCalledWith(
      [],
      expect.any(Set),
    );
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(memory.adapter.mkdir).not.toHaveBeenCalled();
    expect(memory.adapter.remove).not.toHaveBeenCalled();
    expect(
      state.getCommittedV2Envelope()?.folderAnchors?.byAnchorId[
        "folder:plugin-folder-id"
      ],
    ).toMatchObject({
      remoteId: "plugin-folder-id",
      lastPath: ".obsidian/plugins/calendar",
    });

    memory.text.set(manifestPath, PLUGIN_MANIFEST_TEXT);
    localEntries.push(localManifest);
    participating = true;
    executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });
    downloadFile.mockClear();
    memory.adapter.writeBinary.mockClear();

    const restored = await executor.run("manual");

    expect(restored.success).toBe(true);
    expect(restored.deferred).toBe(0);
    expect(restored.downloaded).toBe(1);
    expect(downloadFile.mock.calls.map((call) => call[1])).toContain(mainPath);
    expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(bytes("main")),
    );
  });

  it("restores a wholly absent bundle after explicit participation from a disabled scope", async () => {
    const enablement = bytes("[]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const stylesPath = ".obsidian/plugins/calendar/styles.css";
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const remoteManifest = await remoteEntry(
      manifestPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const remoteStyles = await remoteEntry(stylesPath, bytes("styles"));
    const baseEntries: BaseFileEntry[] = [
      sharedBaseEntry(
        await localEntry(mainPath, bytes("main")),
        remoteMain,
      ),
      sharedBaseEntry(
        await localEntry(manifestPath, bytes(PLUGIN_MANIFEST_TEXT)),
        remoteManifest,
      ),
    ];
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const localEntries = [localCommunity];
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: enablement });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === COMMUNITY_PATH) return enablement;
      if (path === mainPath) return bytes("main");
      if (path === manifestPath) return bytes(PLUGIN_MANIFEST_TEXT);
      if (path === stylesPath) return bytes("styles");
      return new ArrayBuffer(0);
    });
    const state = makeState(
      [remoteCommunity, remoteMain, remoteManifest, remoteStyles],
      baseEntries,
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: false },
          pending: [],
        }),
      },
    );
    const previousPolicy: CommunityPluginSyncPolicyV1 = {
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    };
    const rejoined = updateCommunityPluginSelection(
      {
        filesEnabled: false,
        dataEnabled: false,
        policy: previousPolicy,
      },
      "files",
      "calendar",
      true,
      ["calendar"],
    );
    const fullRemoteEntries = [
      remoteCommunity,
      remoteMain,
      remoteManifest,
      remoteStyles,
    ];
    const { executor } = makeExecutor({
      localEntries,
      localFolders: REMOTE_FOLDERS
        .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
        .map((folder) => ({
          path: folder.path,
          mtime: 1,
        })),
      remoteEntries: fullRemoteEntries,
      remoteContent: enablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: completeRemoteItems(fullRemoteEntries),
          "@odata.deltaLink": "delta-token-next",
        }),
      }),
      policy: readCommunityPluginSyncPolicy(
        JSON.parse(JSON.stringify(rejoined.policy)),
      ),
    });

    const restored = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        communityPluginJoinAuthorizations: [
          joinAuthorization([remoteMain, remoteManifest, remoteStyles]),
        ],
      },
    );

    expect(restored.success).toBe(true);
    expect(restored.deferred).toBe(0);
    expect(restored.errors).toBe(0);
    expect(restored.downloaded).toBe(3);
    expect(restored.communityPluginLocalIgnores).toBeUndefined();
    expect(restored.communityPluginRestoresCompleted).toEqual({
      files: ["calendar"],
      data: [],
    });
    expect(downloadFile.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([mainPath, manifestPath, stylesPath]),
    );
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
      new Uint8Array(bytes("main")),
    );
    expect(new Uint8Array(memory.binary.get(manifestPath)!)).toEqual(
      new Uint8Array(bytes(PLUGIN_MANIFEST_TEXT)),
    );
    expect(new Uint8Array(memory.binary.get(stylesPath)!)).toEqual(
      new Uint8Array(bytes("styles")),
    );
    expect(memory.adapter.mkdir).toHaveBeenCalledWith(
      ".obsidian/plugins/calendar",
    );

    const restoredLocalEntries = [
      localCommunity,
      await localEntry(mainPath, bytes("main")),
      await localEntry(manifestPath, bytes(PLUGIN_MANIFEST_TEXT)),
      await localEntry(stylesPath, bytes("styles")),
    ];
    const coldState = makeState(
      [remoteCommunity, remoteMain, remoteManifest, remoteStyles],
      state.baseSnapshot,
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: false },
          pending: [],
        }),
      },
    );
    const coldDownloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === COMMUNITY_PATH ? enablement : new ArrayBuffer(0));
    const cold = makeExecutor({
      localEntries: restoredLocalEntries,
      localFolders: REMOTE_FOLDERS.map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteEntries: [
        remoteCommunity,
        remoteMain,
        remoteManifest,
        remoteStyles,
      ],
      remoteContent: enablement,
      adapter: memory.adapter,
      state: coldState,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        downloadFile: coldDownloadFile,
      }),
      policy: readCommunityPluginSyncPolicy({
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      }),
    });
    memory.adapter.writeBinary.mockClear();

    const stable = await cold.executor.run("manual");

    expect(stable).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(stable.communityPluginLocalIgnores).toBeUndefined();
    expect(stable.communityPluginRestoresCompleted).toBeUndefined();
    expect(coldDownloadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();

  });

  it("blocks a bound restore when the complete remote identity scan sees a replacement", async () => {
    const enablement = bytes("[]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const stylesPath = ".obsidian/plugins/calendar/styles.css";
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const remoteMain = await remoteEntry(mainPath, bytes("main"));
    const remoteManifest = await remoteEntry(
      manifestPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const remoteStyles = await remoteEntry(stylesPath, bytes("styles"));
    const replacedMain = { ...remoteMain, eTag: "etag:replacement" };
    const initialRemote = [
      remoteCommunity,
      remoteMain,
      remoteManifest,
      remoteStyles,
    ];
    const observedRemote = [
      remoteCommunity,
      replacedMain,
      remoteManifest,
      remoteStyles,
    ];
    const baseEntries = [
      sharedBaseEntry(await localEntry(mainPath, bytes("main")), remoteMain),
      sharedBaseEntry(
        await localEntry(manifestPath, bytes(PLUGIN_MANIFEST_TEXT)),
        remoteManifest,
      ),
    ];
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: enablement });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === COMMUNITY_PATH ? enablement : new ArrayBuffer(0));
    const state = makeState(initialRemote, baseEntries, {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { calendar: false },
        pending: [],
      }),
    });
    const { executor } = makeExecutor({
      localEntries: [localCommunity],
      localFolders: REMOTE_FOLDERS
        .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
        .map((folder) => ({ path: folder.path, mtime: 1 })),
      remoteEntries: initialRemote,
      remoteContent: enablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: completeRemoteItems(observedRemote),
          "@odata.deltaLink": "delta-token-next",
        }),
      }),
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        communityPluginJoinAuthorizations: [
          joinAuthorization([remoteMain, remoteManifest, remoteStyles]),
        ],
      },
    );

    expect(result).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 1,
      errors: 0,
      communityPluginJoinBlocks: [{
        pluginId: "calendar",
        operationId: "join-calendar-1",
        reason: "remote-bundle-changed",
      }],
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(memory.adapter.remove).not.toHaveBeenCalled();
  });

  it("keeps an absent selected remote bundle mutation-free", async () => {
    const enablement = bytes("[]");
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: enablement });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [localCommunity],
      localFolders: REMOTE_FOLDERS
        .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
        .map((folder) => ({ path: folder.path, mtime: 1 })),
      remoteEntries: [remoteCommunity],
      remoteContent: enablement,
      adapter: memory.adapter,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: completeRemoteItems([remoteCommunity]),
          "@odata.deltaLink": "delta-token-next",
        }),
      }),
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(result.communityPluginRestoresCompleted).toBeUndefined();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("restores absent plugin data after the user confirms files and data together", async () => {
    const enablement = bytes("[]");
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const dataPath = ".obsidian/plugins/calendar/data.json";
    const mainBytes = bytes("main");
    const manifestBytes = bytes(PLUGIN_MANIFEST_TEXT);
    const dataBytes = bytes('{"restored":true}');
    const remoteCommunity = await remoteEntry(COMMUNITY_PATH, enablement);
    const remoteMain = await remoteEntry(mainPath, mainBytes);
    const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
    const remoteData = await remoteEntry(dataPath, dataBytes);
    const localCommunity = await localEntry(COMMUNITY_PATH, enablement);
    const localMain = await localEntry(mainPath, mainBytes);
    const localManifest = await localEntry(manifestPath, manifestBytes);
    const historicalData = await localEntry(dataPath, dataBytes);
    const baseEntries = [
      sharedBaseEntry(localMain, remoteMain),
      sharedBaseEntry(localManifest, remoteManifest),
      sharedBaseEntry(historicalData, remoteData),
    ];
    const memory = makeMemoryAdapter({
      [COMMUNITY_PATH]: enablement,
      [mainPath]: mainBytes,
      [manifestPath]: manifestBytes,
    });
    const deleteItem = vi.fn();
    const uploadFile = vi.fn();
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === COMMUNITY_PATH) return enablement;
      if (path === dataPath) return dataBytes;
      return new ArrayBuffer(0);
    });
    const state = makeState(
      [remoteCommunity, remoteMain, remoteManifest, remoteData],
      baseEntries,
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { calendar: false },
          pending: [],
        }),
      },
    );
    const participation = enableCommunityPluginDataWithFiles(
      {
        filesEnabled: false,
        dataEnabled: false,
        policy: {
          version: 1,
          files: { mode: "all", pluginIds: [] },
          data: { mode: "all", pluginIds: [] },
        },
      },
      "calendar",
      ["calendar"],
    );
    const { executor } = makeExecutor({
      localEntries: [localCommunity, localMain, localManifest],
      localFolders: REMOTE_FOLDERS.map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteEntries: [
        remoteCommunity,
        remoteMain,
        remoteManifest,
        remoteData,
      ],
      remoteContent: enablement,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(enablement, {
        deleteItem,
        uploadFile,
        downloadFile,
      }),
      policy: readCommunityPluginSyncPolicy(
        JSON.parse(JSON.stringify(participation.policy)),
      ),
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(result.communityPluginLocalIgnores).toBeUndefined();
    expect(result.communityPluginRestoresCompleted).toEqual({
      files: [],
      data: ["calendar"],
    });
    expect(downloadFile.mock.calls.map((call) => call[1])).toContain(dataPath);
    expect(memory.binary.get(dataPath)).toEqual(dataBytes);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("restores remotely missing plugin files from a participating local bundle", async () => {
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainBytes = bytes("main");
    const manifestBytes = bytes(PLUGIN_MANIFEST_TEXT);
    const localMain = await localEntry(mainPath, mainBytes);
    const localManifest = await localEntry(manifestPath, manifestBytes);
    const baseEntries: BaseFileEntry[] = [
      {
        path: mainPath,
        size: localMain.size,
        hash: localMain.hash,
        eTag: "etag:old-main",
      },
      {
        path: manifestPath,
        size: localManifest.size,
        hash: localManifest.hash,
        eTag: "etag:old-manifest",
      },
    ];
    const memory = makeMemoryAdapter({
      [mainPath]: mainBytes,
      [manifestPath]: PLUGIN_MANIFEST_TEXT,
    });
    memory.binary.set(manifestPath, manifestBytes);
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => ({
      id: `id:${path}`,
      eTag: `etag:new:${path}`,
      size: content.byteLength,
      parentReference: { id: "plugin-folder-id" },
    }));
    const state = makeState([], baseEntries, {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { calendar: false },
        pending: [],
      }),
    });
    const { executor } = makeExecutor({
      localEntries: [localMain, localManifest],
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { uploadFile }),
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.uploaded).toBe(2);
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      mainPath,
      expect.any(ArrayBuffer),
      undefined,
      undefined,
      undefined,
    );
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      manifestPath,
      expect.any(ArrayBuffer),
      undefined,
      undefined,
      undefined,
    );
  });

  it("expires stale one-sided plugin conflicts instead of accepting a destructive choice", async () => {
    const remoteOnlyPath = ".obsidian/plugins/calendar/main.js";
    const localOnlyPath = ".obsidian/plugins/calendar/manifest.json";
    const localManifest = await localEntry(
      localOnlyPath,
      bytes(PLUGIN_MANIFEST_TEXT),
    );
    const remoteMain = await remoteEntry(remoteOnlyPath, bytes("main"));
    const memory = makeMemoryAdapter({
      [localOnlyPath]: bytes(PLUGIN_MANIFEST_TEXT),
    });
    const deleteItem = vi.fn();
    const state = makeState([remoteMain], [], {
      pendingConflicts: [
        {
          type: "conflict",
          path: remoteOnlyPath,
          remote: remoteMain,
          reason: "reason.localDeletedRemoteModified",
        },
        {
          type: "conflict",
          path: localOnlyPath,
          local: localManifest,
          reason: "reason.remoteDeletedLocalModified",
        },
      ],
      pendingRemoteDeletes: [{
        type: "confirmLocalDelete",
        path: localOnlyPath,
        local: localManifest,
        reason: "reason.fileDeletedFromRemote",
      }],
    });
    const { executor } = makeExecutor({
      localEntries: [localManifest],
      remoteEntries: [remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { deleteItem }),
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    await executor.resolveConflictKeepLocal(remoteOnlyPath);
    await executor.resolveConflictKeepRemote(localOnlyPath);
    await executor.confirmRemoteDelete(localOnlyPath);

    expect(state.removePendingConflict).toHaveBeenCalledWith(remoteOnlyPath);
    expect(state.removePendingConflict).toHaveBeenCalledWith(localOnlyPath);
    expect(state.removePendingDelete).toHaveBeenCalledWith(localOnlyPath);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(memory.adapter.remove).not.toHaveBeenCalled();
  });

  it("does not write any selected plugin file when bundle preflight is incomplete", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const manifestBytes = bytes(JSON.stringify({
      id: "calendar",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    }));
    const mainBytes = bytes("main");
    const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
    const remoteMain = await remoteEntry(mainPath, mainBytes);
    const memory = makeMemoryAdapter({});
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === mainPath) throw new Error("main download failed");
      return manifestBytes;
    });
    const { executor } = makeExecutor({
      localEntries: [],
      remoteEntries: [remoteManifest, remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      oneDrive: makeOneDrive(null, { downloadFile }),
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(memory.binary.has(manifestPath)).toBe(false);
    expect(memory.binary.has(mainPath)).toBe(false);
    expect(memory.adapter.writeBinary).not.toHaveBeenCalledWith(
      expect.stringContaining("/plugins/calendar/"),
      expect.any(ArrayBuffer),
    );
  });

  it("blocks a selected plugin downgrade before writing bundle files", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localManifest = JSON.stringify({
      id: "calendar",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    });
    const remoteManifestBytes = bytes(JSON.stringify({
      id: "calendar",
      version: "1.9.0",
      minAppVersion: "1.5.0",
    }));
    const remoteMainBytes = bytes("older-main");
    const remoteManifest = await remoteEntry(manifestPath, remoteManifestBytes);
    const remoteMain = await remoteEntry(mainPath, remoteMainBytes);
    const memory = makeMemoryAdapter({
      [manifestPath]: localManifest,
      [mainPath]: bytes("current-main"),
    });
    const localManifestEntry = await localEntry(manifestPath, bytes(localManifest));
    const localMainEntry = await localEntry(mainPath, bytes("current-main"));
    const state = makeState(
      [remoteManifest, remoteMain],
      [
        {
          path: manifestPath,
          size: localManifestEntry.size,
          hash: localManifestEntry.hash,
          eTag: "etag:base:manifest",
        },
        {
          path: mainPath,
          size: localMainEntry.size,
          hash: localMainEntry.hash,
          eTag: "etag:base:main",
        },
      ],
    );
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === manifestPath ? remoteManifestBytes : remoteMainBytes);
    const { executor } = makeExecutor({
      localEntries: [localManifestEntry, localMainEntry],
      remoteEntries: [remoteManifest, remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { downloadFile }),
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(memory.text.get(manifestPath)).toBe(localManifest);
    expect(new TextDecoder().decode(memory.binary.get(mainPath))).toBe("current-main");
  });

  it("lets a selected plugin with non-SemVer raw versions upload without an automatic downgrade judgment", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localManifestText = JSON.stringify({
      id: "calendar",
      version: "1.5.12.11",
      minAppVersion: "1.5.0",
    });
    const remoteManifestBytes = bytes(JSON.stringify({
      id: "calendar",
      version: "1.5.12.10",
      minAppVersion: "1.5.0",
    }));
    const localManifestBytes = bytes(localManifestText);
    const localMainBytes = bytes("new-main");
    const remoteMainBytes = bytes("old-main");
    const localManifest = await localEntry(manifestPath, localManifestBytes);
    const localMain = await localEntry(mainPath, localMainBytes);
    const remoteManifest = await remoteEntry(manifestPath, remoteManifestBytes);
    const remoteMain = await remoteEntry(mainPath, remoteMainBytes);
    const memory = makeMemoryAdapter({
      [mainPath]: localMainBytes,
    });
    memory.text.set(manifestPath, localManifestText);
    memory.binary.set(manifestPath, localManifestBytes);
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => ({
      id: path === manifestPath ? remoteManifest.driveId : remoteMain.driveId,
      eTag: `etag:uploaded:${path}`,
      size: content.byteLength,
      parentReference: { id: "plugin-folder-id" },
    }));
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === manifestPath ? remoteManifestBytes : remoteMainBytes);
    const state = makeState(
      [remoteManifest, remoteMain],
      [
        sharedBaseEntry(
          await localEntry(manifestPath, remoteManifestBytes),
          remoteManifest,
        ),
        sharedBaseEntry(
          await localEntry(mainPath, remoteMainBytes),
          remoteMain,
        ),
      ],
    );
    const { executor } = makeExecutor({
      localEntries: [localManifest, localMain],
      remoteEntries: [remoteManifest, remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, {
        downloadFile,
        uploadFile,
      }),
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 2,
      errors: 0,
    });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });

  it("blocks a host-incompatible selected plugin before writing bundle files", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      vi.mocked(requireApiVersion).mockReturnValueOnce(false);
      const manifestPath = ".obsidian/plugins/calendar/manifest.json";
      const mainPath = ".obsidian/plugins/calendar/main.js";
      const manifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.0.0",
        minAppVersion: "99.0.0",
      }));
      const mainBytes = bytes("main");
      const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
      const remoteMain = await remoteEntry(mainPath, mainBytes);
      const remoteEntries = [remoteManifest, remoteMain];
      const memory = makeMemoryAdapter({});
      const downloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
      ) => path === manifestPath ? manifestBytes : mainBytes);
      const { executor } = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS
          .filter((folder) => folder.path !== ".obsidian/plugins/calendar")
          .map((folder) => ({ path: folder.path, mtime: 1 })),
        remoteEntries,
        remoteContent: null,
        adapter: memory.adapter,
        oneDrive: makeOneDrive(null, {
          downloadFile,
          getDelta: vi.fn().mockResolvedValue({
            value: completeRemoteItems(remoteEntries),
            "@odata.deltaLink": "delta-token-next",
          }),
        }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const result = await executor.run(
        "manual",
        {},
        false,
        undefined,
        {
          communityPluginJoinAuthorizations: [
            joinAuthorization(remoteEntries),
          ],
        },
      );

      expect(result).toMatchObject({
        downloaded: 0,
        deferred: 1,
        errors: 0,
        communityPluginJoinBlocks: [{
          pluginId: "calendar",
          operationId: "join-calendar-1",
          reason: "manifest-incompatible",
        }],
      });
      expect(memory.binary.has(manifestPath)).toBe(false);
      expect(memory.binary.has(mainPath)).toBe(false);
      expect(memory.adapter.mkdir).not.toHaveBeenCalled();
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("keeps a desktop-only restore dormant on mobile until a compatible bundle appears", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const rootPath = ".obsidian/plugins/calendar";
      const manifestPath = `${rootPath}/manifest.json`;
      const mainPath = `${rootPath}/main.js`;
      const stylesPath = `${rootPath}/styles.css`;
      const manifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.0.0",
        minAppVersion: "1.5.0",
        isDesktopOnly: true,
      }));
      const mainBytes = bytes("main");
      const stylesBytes = bytes("styles");
      const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
      const remoteMain = await remoteEntry(mainPath, mainBytes);
      const remoteStyles = await remoteEntry(stylesPath, stylesBytes);
      const historicalBase = [
        sharedBaseEntry(
          await localEntry(manifestPath, manifestBytes),
          remoteManifest,
        ),
        sharedBaseEntry(await localEntry(mainPath, mainBytes), remoteMain),
        sharedBaseEntry(
          await localEntry(stylesPath, stylesBytes),
          remoteStyles,
        ),
      ];
      const memory = makeMemoryAdapter({});
      const downloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
      ) => {
        if (path === manifestPath) return manifestBytes;
        if (path === mainPath) return mainBytes;
        if (path === stylesPath) return stylesBytes;
        return new ArrayBuffer(0);
      });
      const state = makeState(
        [remoteManifest, remoteMain, remoteStyles],
        historicalBase,
      );
      const { executor } = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS
          .filter((folder) => folder.path !== rootPath)
          .map((folder) => ({
            path: folder.path,
            mtime: 1,
          })),
        remoteEntries: [remoteManifest, remoteMain, remoteStyles],
        remoteContent: null,
        adapter: memory.adapter,
        state,
        oneDrive: makeOneDrive(null, {
          downloadFile,
          getDelta: vi.fn().mockResolvedValue({
            value: completeRemoteItems([
              remoteManifest,
              remoteMain,
              remoteStyles,
            ]),
            "@odata.deltaLink": "delta-token-next",
          }),
        }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const desktopOnlyAuthorization = joinAuthorization([
        remoteManifest,
        remoteMain,
        remoteStyles,
      ]);
      const first = await executor.run("manual", {}, false, undefined, {
        communityPluginJoinAuthorizations: [desktopOnlyAuthorization],
      });
      const second = await executor.run("manual", {}, false, undefined, {
        communityPluginJoinAuthorizations: [desktopOnlyAuthorization],
      });

      expect(first.communityPluginRestoresCompleted).toBeUndefined();
      expect(second.communityPluginRestoresCompleted).toBeUndefined();
      for (const result of [first, second]) {
        expect(result.success).toBe(true);
        expect(result.errors).toBe(0);
        expect(result.deferred).toBe(1);
        expect(result.downloaded).toBe(0);
        expect(result.foldersCreated).toBe(0);
        expect(result.communityPluginLocalIgnores).toBeUndefined();
      }
      expect(downloadFile.mock.calls.map((call) => call[1])).toEqual([
        manifestPath,
      ]);
      expect(memory.adapter.mkdir).not.toHaveBeenCalled();
      expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
      expect(memory.adapter.remove).not.toHaveBeenCalled();
      expect(state.reconcilePendingIssues).toHaveBeenLastCalledWith(
        [],
        expect.any(Set),
      );

      const compatibleManifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.1.0",
        minAppVersion: "1.5.0",
      }));
      const compatibleManifest = await remoteEntry(
        manifestPath,
        compatibleManifestBytes,
        {
          eTag: "etag:calendar:compatible",
          cTag: "ctag:calendar:compatible",
        },
      );
      const compatibleDownloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
      ) => {
        if (path === manifestPath) return compatibleManifestBytes;
        if (path === mainPath) return mainBytes;
        if (path === stylesPath) return stylesBytes;
        return new ArrayBuffer(0);
      });
      const deleteItem = vi.fn();
      const uploadFile = vi.fn();
      const compatibleState = makeState(
        [compatibleManifest, remoteMain, remoteStyles],
        historicalBase,
      );
      const compatible = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS
          .filter((folder) => folder.path !== rootPath)
          .map((folder) => ({ path: folder.path, mtime: 1 })),
        remoteEntries: [compatibleManifest, remoteMain, remoteStyles],
        remoteContent: null,
        adapter: memory.adapter,
        state: compatibleState,
        oneDrive: makeOneDrive(null, {
          deleteItem,
          uploadFile,
          downloadFile: compatibleDownloadFile,
          getDelta: vi.fn().mockResolvedValue({
            value: completeRemoteItems([
              compatibleManifest,
              remoteMain,
              remoteStyles,
            ]),
            "@odata.deltaLink": "delta-token-compatible",
          }),
        }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const restored = await compatible.executor.run(
        "manual",
        {},
        false,
        undefined,
        {
          communityPluginJoinAuthorizations: [joinAuthorization([
            compatibleManifest,
            remoteMain,
            remoteStyles,
          ])],
        },
      );

      expect(restored).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 3,
        deleted: 0,
        deferred: 0,
        errors: 0,
      });
      expect(restored.communityPluginRestoresCompleted).toEqual({
        files: ["calendar"],
        data: [],
      });
      expect(deleteItem).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("A0-P bounds new-device mobile manifest reads and reuses compatible bytes in bundle staging", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const pluginIds = ["alpha", "bravo", "charlie", "delta", "echo"];
      const remoteFolders: RemoteFolderEntry[] = [
        ...REMOTE_FOLDERS.slice(0, 2),
        ...pluginIds.map((pluginId) => ({
          path: `.obsidian/plugins/${pluginId}`,
          driveId: `plugin-folder-id:${pluginId}`,
          parentId: "plugins-folder-id",
          name: pluginId,
        })),
      ];
      const contentByPath = new Map<string, ArrayBuffer>();
      const remoteEntries: RemoteFileEntry[] = [];
      for (const pluginId of pluginIds) {
        const manifestPath = `.obsidian/plugins/${pluginId}/manifest.json`;
        const mainPath = `.obsidian/plugins/${pluginId}/main.js`;
        const manifestBytes = bytes(JSON.stringify({
          id: pluginId,
          version: "1.0.0",
          minAppVersion: "1.5.0",
        }));
        const mainBytes = bytes(`main:${pluginId}`);
        contentByPath.set(manifestPath, manifestBytes);
        contentByPath.set(mainPath, mainBytes);
        remoteEntries.push(
          await remoteEntry(manifestPath, manifestBytes, {
            parentId: `plugin-folder-id:${pluginId}`,
          }),
          await remoteEntry(mainPath, mainBytes, {
            parentId: `plugin-folder-id:${pluginId}`,
          }),
        );
      }
      let activeManifestReads = 0;
      let peakManifestReads = 0;
      const downloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
        _downloadUrl?: string,
        _driveItemId?: string,
        _fileSize?: number,
        onProgress?: (downloaded: number, total: number) => void,
      ) => {
        if (path.endsWith("/manifest.json")) {
          activeManifestReads++;
          peakManifestReads = Math.max(
            peakManifestReads,
            activeManifestReads,
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeManifestReads--;
        }
        const content = contentByPath.get(path) ?? new ArrayBuffer(0);
        onProgress?.(0, content.byteLength);
        onProgress?.(content.byteLength, content.byteLength);
        return content;
      });
      const log = vi.fn();
      const state = makeState(remoteEntries, [], {}, remoteFolders);
      const memory = makeMemoryAdapter({});
      const progressStore = new SyncProgressStore();
      progressStore.markStarted();
      const progressSnapshots: Array<{
        current: number;
        total: number;
        currentFile: string;
        currentItemBytes: number;
        currentItemTotalBytes: number;
      }> = [];
      const { executor } = makeExecutor({
        localEntries: [],
        localFolders: remoteFolders.slice(0, 2).map((folder) => ({
          path: folder.path,
        })),
        remoteEntries,
        remoteFolders,
        remoteContent: null,
        adapter: memory.adapter,
        state,
        progressStore,
        oneDrive: makeOneDrive(null, { downloadFile }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds,
          },
          data: { mode: "none", pluginIds: [] },
        },
        diag: {
          log,
          warn: vi.fn(),
          error: vi.fn(),
          isEnabled: vi.fn().mockReturnValue(false),
        } as never,
      });

      const result = await executor.run("manual", {
        onFileProgress: (downloaded, total) => {
          progressStore.setByteProgress(downloaded, total);
          progressSnapshots.push({
            current: progressStore.state.current,
            total: progressStore.state.total,
            currentFile: progressStore.state.currentFile,
            currentItemBytes: progressStore.state.currentItemBytes,
            currentItemTotalBytes:
              progressStore.state.currentItemTotalBytes,
          });
        },
      });

      expect(result.success).toBe(true);
      expect(result.downloaded).toBe(pluginIds.length * 2);
      expect(downloadFile).toHaveBeenCalledTimes(pluginIds.length * 2);
      for (const pluginId of pluginIds) {
        const manifestPath = `.obsidian/plugins/${pluginId}/manifest.json`;
        const mainPath = `.obsidian/plugins/${pluginId}/main.js`;
        const bundleBytes = contentByPath.get(manifestPath)!.byteLength
          + contentByPath.get(mainPath)!.byteLength;
        expect(downloadFile.mock.calls.filter(
          (call) => call[1] === manifestPath,
        )).toHaveLength(1);
        const bundleSnapshot = progressSnapshots.find((snapshot) =>
          snapshot.currentFile === `.obsidian/plugins/${pluginId}`
          && snapshot.currentItemBytes === bundleBytes
          && snapshot.currentItemTotalBytes === bundleBytes);
        expect(bundleSnapshot).toBeDefined();
        expect(bundleSnapshot!.current).toBeGreaterThan(0);
        expect(bundleSnapshot!.total).toBeGreaterThanOrEqual(
          pluginIds.length * 2,
        );
      }
      expect(peakManifestReads).toBeGreaterThan(1);
      expect(peakManifestReads).toBeLessThanOrEqual(3);
      expect(state.setCommunityPluginManifestObservations)
        .toHaveBeenCalledWith(expect.arrayContaining(
          pluginIds.map((pluginId) =>
            expect.objectContaining({ pluginId })),
        ));
      expect(log).toHaveBeenCalledWith(
        "execute",
        "community plugin manifest participation preflight",
        expect.objectContaining({
          candidates: pluginIds.length,
          cacheHits: 0,
          manifestReads: pluginIds.length,
          concurrencyLimit: 3,
          peakConcurrency: 3,
          elapsedMs: expect.any(Number),
        }),
      );
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("A0-P reuses source-bound desktop-only evidence after reload so a stable mobile round performs only delta", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const rootPath = ".obsidian/plugins/calendar";
      const manifestPath = `${rootPath}/manifest.json`;
      const mainPath = `${rootPath}/main.js`;
      const manifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.0.0",
        minAppVersion: "1.5.0",
        isDesktopOnly: true,
      }));
      const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
      const remoteMain = await remoteEntry(mainPath, bytes("main"));
      let observations: CommunityPluginManifestObservationV1[] = [];
      const observationStore = {
        getCommunityPluginManifestObservations: vi.fn(
          () => structuredClone(observations),
        ),
        setCommunityPluginManifestObservations: vi.fn(async (
          next: CommunityPluginManifestObservationV1[],
        ) => {
          observations = structuredClone(next);
        }),
      };
      const firstDownload = vi.fn().mockResolvedValue(manifestBytes);
      const firstState = makeState(
        [remoteManifest, remoteMain],
        [],
        observationStore,
      );
      const firstMemory = makeMemoryAdapter({});
      const first = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS.map((folder) => ({
          path: folder.path,
        })),
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: firstMemory.adapter,
        state: firstState,
        oneDrive: makeOneDrive(null, { downloadFile: firstDownload }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      expect((await first.executor.run("manual")).success).toBe(true);
      expect(firstDownload).toHaveBeenCalledTimes(1);
      expect(observations).toHaveLength(1);

      const stableDownload = vi.fn();
      const stableDelta = vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "delta-token-stable",
      });
      const stableState = makeState(
        [remoteManifest, remoteMain],
        [],
        observationStore,
      );
      const stableMemory = makeMemoryAdapter({});
      const stable = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS.map((folder) => ({
          path: folder.path,
        })),
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: stableMemory.adapter,
        state: stableState,
        oneDrive: makeOneDrive(null, {
          downloadFile: stableDownload,
          getDelta: stableDelta,
        }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const result = await stable.executor.run("manual");

      expect(result.success).toBe(true);
      expect(result.downloaded).toBe(0);
      expect(stableDelta).toHaveBeenCalledTimes(1);
      expect(stableDownload).not.toHaveBeenCalled();
      expect(stable.oneDrive.initVaultScope).not.toHaveBeenCalled();
      expect(stable.oneDrive.uploadFile).not.toHaveBeenCalled();
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("does not reuse a desktop-only observation from another sync scope", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const manifestPath = ".obsidian/plugins/calendar/manifest.json";
      const mainPath = ".obsidian/plugins/calendar/main.js";
      const manifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.0.0",
        minAppVersion: "1.5.0",
        isDesktopOnly: true,
      }));
      const remoteManifest = await remoteEntry(manifestPath, manifestBytes);
      const remoteMain = await remoteEntry(mainPath, bytes("main"));
      let observations: CommunityPluginManifestObservationV1[] = [];
      const store = {
        getCommunityPluginManifestObservations: vi.fn(
          () => structuredClone(observations),
        ),
        setCommunityPluginManifestObservations: vi.fn(async (
          next: CommunityPluginManifestObservationV1[],
        ) => {
          observations = structuredClone(next);
        }),
      };
      const firstDownload = vi.fn().mockResolvedValue(manifestBytes);
      const firstState = makeState(
        [remoteManifest, remoteMain],
        [],
        store,
      );
      const firstMemory = makeMemoryAdapter({});
      const first = makeExecutor({
        localEntries: [],
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: firstMemory.adapter,
        state: firstState,
        oneDrive: makeOneDrive(null, { downloadFile: firstDownload }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });
      await first.executor.run("manual");
      observations[0].scope.accountId = "other-account";

      const secondDownload = vi.fn().mockResolvedValue(manifestBytes);
      const secondState = makeState(
        [remoteManifest, remoteMain],
        [],
        store,
      );
      const secondMemory = makeMemoryAdapter({});
      const second = makeExecutor({
        localEntries: [],
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: secondMemory.adapter,
        state: secondState,
        oneDrive: makeOneDrive(null, { downloadFile: secondDownload }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      expect((await second.executor.run("manual")).success).toBe(true);
      expect(secondDownload).toHaveBeenCalledTimes(1);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("re-evaluates a mobile non-participant when the remote manifest version changes", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const rootPath = ".obsidian/plugins/calendar";
      const manifestPath = `${rootPath}/manifest.json`;
      const mainPath = `${rootPath}/main.js`;
      const desktopManifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.0.0",
        minAppVersion: "1.5.0",
        isDesktopOnly: true,
      }));
      const mobileManifestBytes = bytes(JSON.stringify({
        id: "calendar",
        version: "2.1.0",
        minAppVersion: "1.5.0",
      }));
      const mainBytes = bytes("main");
      let activeManifestBytes = desktopManifestBytes;
      const remoteManifest = await remoteEntry(
        manifestPath,
        desktopManifestBytes,
      );
      const remoteMain = await remoteEntry(mainPath, mainBytes);
      const memory = makeMemoryAdapter({});
      const observedManifestContents: string[] = [];
      const downloadFile = vi.fn(async (
        _vaultName: string,
        path: string,
      ) => {
        if (path === manifestPath) {
          observedManifestContents.push(
            new TextDecoder().decode(activeManifestBytes),
          );
          return activeManifestBytes;
        }
        if (path === mainPath) return mainBytes;
        return new ArrayBuffer(0);
      });
      const state = makeState([remoteManifest, remoteMain]);
      const { executor } = makeExecutor({
        localEntries: [],
        localFolders: REMOTE_FOLDERS.map((folder) => ({
          path: folder.path,
          mtime: 1,
        })),
        remoteEntries: [remoteManifest, remoteMain],
        remoteContent: null,
        adapter: memory.adapter,
        state,
        oneDrive: makeOneDrive(null, { downloadFile }),
        policy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["calendar"],
          },
          data: { mode: "none", pluginIds: [] },
        },
      });

      const excluded = await executor.run("manual");
      expect(excluded.success).toBe(true);
      expect(excluded.downloaded).toBe(0);
      expect(memory.adapter.writeBinary).not.toHaveBeenCalled();

      activeManifestBytes = mobileManifestBytes;
      const updatedManifest = await remoteEntry(
        manifestPath,
        mobileManifestBytes,
        {
          eTag: "etag:manifest:mobile-compatible",
          cTag: "ctag:manifest:mobile-compatible",
        },
      );
      await state.setRemoteState(
        [updatedManifest, remoteMain],
        "delta-token-updated",
        SCOPE,
        REMOTE_FOLDERS,
      );

      const restored = await executor.run("manual");

      expect(restored.success).toBe(true);
      expect(restored.errors).toBe(0);
      expect(restored.deferred).toBe(0);
      expect(restored.downloaded).toBe(2);
      expect(new Uint8Array(memory.binary.get(manifestPath)!)).toEqual(
        new Uint8Array(mobileManifestBytes),
      );
      expect(new Uint8Array(memory.binary.get(mainPath)!)).toEqual(
        new Uint8Array(mainBytes),
      );
      expect(observedManifestContents).toEqual([
        new TextDecoder().decode(desktopManifestBytes),
        new TextDecoder().decode(mobileManifestBytes),
      ]);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("blocks a selected plugin upload when its manifest identity is unsafe", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localManifestText = JSON.stringify({
      id: "../other",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    });
    const localManifest = await localEntry(manifestPath, bytes(localManifestText));
    const localMain = await localEntry(mainPath, bytes("main"));
    const memory = makeMemoryAdapter({
      [manifestPath]: localManifestText,
      [mainPath]: bytes("main"),
    });
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [localManifest, localMain],
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      oneDrive: makeOneDrive(null, { uploadFile }),
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("blocks both selected directories when they claim the same manifest id", async () => {
    const directoryIds = ["pkmer-copy-a", "pkmer-copy-b"];
    const manifestText = JSON.stringify({
      id: "pkmer",
      name: "PKMer",
      version: "1.0.0",
    });
    const localEntries: LocalFileEntry[] = [];
    const memoryFiles: Record<string, ArrayBuffer | string> = {};
    const remoteFolders = [...REMOTE_FOLDERS.slice(0, 2)];
    for (const [index, directoryId] of directoryIds.entries()) {
      const root = `.obsidian/plugins/${directoryId}`;
      const mainPath = `${root}/main.js`;
      const manifestPath = `${root}/manifest.json`;
      localEntries.push(
        await localEntry(mainPath, bytes(`main-${index}`)),
        await localEntry(manifestPath, bytes(manifestText)),
      );
      memoryFiles[mainPath] = bytes(`main-${index}`);
      memoryFiles[manifestPath] = manifestText;
      remoteFolders.push({
        path: root,
        driveId: `plugin-folder-${index}`,
        parentId: "plugins-folder-id",
        name: directoryId,
      });
    }
    const memory = makeMemoryAdapter(memoryFiles);
    const uploadFile = vi.fn();
    const state = makeState([], [], {}, remoteFolders);
    const { executor } = makeExecutor({
      localEntries,
      localFolders: remoteFolders.map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      remoteEntries: [],
      remoteFolders,
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { uploadFile }),
      policy: {
        version: 1,
        files: { mode: "selected", pluginIds: directoryIds },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("blocks a selected plugin upload that would downgrade the remote bundle", async () => {
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localManifestText = JSON.stringify({
      id: "calendar",
      version: "1.9.0",
      minAppVersion: "1.5.0",
    });
    const remoteManifestBytes = bytes(JSON.stringify({
      id: "calendar",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    }));
    const remoteMainBytes = bytes("newer-main");
    const localManifest = await localEntry(manifestPath, bytes(localManifestText));
    const localMain = await localEntry(mainPath, bytes("older-main"));
    const remoteManifest = await remoteEntry(manifestPath, remoteManifestBytes);
    const remoteMain = await remoteEntry(mainPath, remoteMainBytes);
    const memory = makeMemoryAdapter({
      [manifestPath]: localManifestText,
      [mainPath]: bytes("older-main"),
    });
    const state = makeState(
      [remoteManifest, remoteMain],
      [
        {
          path: manifestPath,
          size: remoteManifest.size,
          hash: remoteManifest.sha256Hash!,
          eTag: remoteManifest.eTag,
        },
        {
          path: mainPath,
          size: remoteMain.size,
          hash: remoteMain.sha256Hash!,
          eTag: remoteMain.eTag,
        },
      ],
    );
    const downloadFile = vi.fn(async (
      _vaultName: string,
      path: string,
    ) => path === manifestPath ? remoteManifestBytes : remoteMainBytes);
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [localManifest, localMain],
      remoteEntries: [remoteManifest, remoteMain],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(null, { downloadFile, uploadFile }),
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("rebuilds a legacy remote cache before trusting its plugin folder inventory", async () => {
    const memory = makeMemoryAdapter({});
    const state = makeState([], [], {
      hasCompleteRemoteFolderIndex: false,
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "delta-token-rebuilt",
    });
    const oneDrive = makeOneDrive(null, { getDelta });
    const { executor } = makeExecutor({
      localEntries: [],
      remoteEntries: [],
      remoteContent: null,
      adapter: memory.adapter,
      state,
      oneDrive,
      localFolders: [],
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(getDelta).not.toHaveBeenCalledWith("testVault", "delta-token");
    expect(state.setRemoteState).toHaveBeenCalledWith(
      [],
      "delta-token-rebuilt",
      SCOPE,
      [],
    );
  });

  it("keeps community-plugins.json completely outside sync even when both sides differ", async () => {
    const localContent = bytes("[\"calendar\"]");
    const remoteContent = bytes("[]");
    const local = await localEntry(COMMUNITY_PATH, localContent);
    const remote = await remoteEntry(COMMUNITY_PATH, remoteContent);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localContent });
    const state = makeState([remote], [], {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { calendar: false },
        pending: [],
      }),
    });
    const downloadFile = vi.fn().mockResolvedValue(remoteContent);
    const { executor, oneDrive } = makeExecutor({
      localEntries: [local],
      remoteEntries: [remote],
      remoteContent,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(remoteContent, { downloadFile }),
    });

    const result = await executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.attention).toBeUndefined();
    expect(oneDrive.uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(state.setCommunityPluginEnablementState).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(memory.binary.get(COMMUNITY_PATH))).toBe(
      new TextDecoder().decode(localContent),
    );
  });

  it("preserves a dangling enablement id without propagating it or failing a zero-file plan", async () => {
    const pluginId = "startup-optimizer";
    const localContent = bytes(`[\"${pluginId}\"]`);
    const remoteContent = bytes("[]");
    const local = await localEntry(COMMUNITY_PATH, localContent);
    const remote = await remoteEntry(COMMUNITY_PATH, remoteContent);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localContent });
    const state = makeState([remote], [], {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { [pluginId]: false },
        pending: [],
      }),
    });
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [local],
      remoteEntries: [remote],
      remoteContent,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(remoteContent, { uploadFile }),
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      errors: 0,
      conflicts: 0,
      deferred: 0,
    });
    expect(result.attention).toBeUndefined();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(memory.binary.get(COMMUNITY_PATH))).toBe(
      new TextDecoder().decode(localContent),
    );
    expect(state.setCommunityPluginEnablementState).not.toHaveBeenCalled();
  });

  it("keeps an explicitly requested partial bundle actionable so preflight still fails closed", async () => {
    const localContent = bytes("[\"calendar\"]");
    const remoteContent = bytes("[]");
    const stylesPath = ".obsidian/plugins/calendar/styles.css";
    const stylesBytes = bytes("styles");
    const local = await localEntry(COMMUNITY_PATH, localContent);
    const remote = await remoteEntry(COMMUNITY_PATH, remoteContent);
    const remoteStyles = await remoteEntry(stylesPath, stylesBytes);
    const memory = makeMemoryAdapter({ [COMMUNITY_PATH]: localContent });
    const state = makeState([remote, remoteStyles], [], {
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: SCOPE,
        anchors: { calendar: false },
        pending: [],
      }),
    });
    const uploadFile = vi.fn();
    const { executor } = makeExecutor({
      localEntries: [local],
      remoteEntries: [remote, remoteStyles],
      remoteContent,
      adapter: memory.adapter,
      state,
      oneDrive: makeOneDrive(remoteContent, { uploadFile }),
      policy: {
        version: 1,
        files: {
          mode: "selected",
          pluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result.errors).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(memory.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("uses a valid manifest id alias when propagating a complete local bundle", async () => {
    const directoryId = "obsidian-pkmer";
    const manifestId = "pkmer";
    const aliasManifestText = JSON.stringify({
      id: manifestId,
      name: "PKMer",
      version: "1.0.0",
      minAppVersion: "1.5.0",
    });
    const localContent = bytes(`["${manifestId}"]`);
    const remoteContent = bytes("[]");
    const mainPath = `.obsidian/plugins/${directoryId}/main.js`;
    const manifestPath = `.obsidian/plugins/${directoryId}/manifest.json`;
    const mainBytes = bytes("plugin");
    const manifestBytes = bytes(aliasManifestText);
    const local = await localEntry(COMMUNITY_PATH, localContent);
    const remote = await remoteEntry(COMMUNITY_PATH, remoteContent);
    const localMain = await localEntry(mainPath, mainBytes);
    const localManifest = await localEntry(manifestPath, manifestBytes);
    const remoteFolders = [
      ...REMOTE_FOLDERS.slice(0, 2),
      {
        path: `.obsidian/plugins/${directoryId}`,
        driveId: "plugin-folder-id",
        parentId: "plugins-folder-id",
        name: directoryId,
      },
    ];
    const memory = makeMemoryAdapter({
      [COMMUNITY_PATH]: localContent,
      [mainPath]: mainBytes,
      [manifestPath]: manifestBytes,
    });
    memory.text.set(manifestPath, aliasManifestText);
    const state = makeState(
      [remote],
      [],
      {
        getCommunityPluginEnablementState: vi.fn().mockReturnValue({
          version: 1,
          scope: SCOPE,
          anchors: { [directoryId]: false },
          pending: [],
        }),
      },
      remoteFolders,
    );
    const uploadedByPath = new Map<string, string>();
    const uploadFile = vi.fn(async (
      _vaultName: string,
      path: string,
      content: ArrayBuffer,
    ) => {
      uploadedByPath.set(path, new TextDecoder().decode(content));
      return {
        id: path === COMMUNITY_PATH ? remote.driveId : `id:uploaded:${path}`,
        eTag: `etag:uploaded:${path}`,
        size: content.byteLength,
        parentReference: {
          id: path === COMMUNITY_PATH
            ? "obsidian-folder-id"
            : "plugin-folder-id",
        },
      };
    });
    const { executor } = makeExecutor({
      localEntries: [local, localMain, localManifest],
      remoteEntries: [remote],
      remoteContent,
      adapter: memory.adapter,
      state,
      remoteFolders,
      localFolders: remoteFolders.map((folder) => ({
        path: folder.path,
        mtime: 1,
      })),
      oneDrive: makeOneDrive(remoteContent, { uploadFile }),
      policy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
    });

    const result = await executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      errors: 0,
      conflicts: 0,
      deferred: 0,
    });
    expect(uploadedByPath.get(mainPath)).toBe("plugin");
    expect(uploadedByPath.get(manifestPath)).toBe(aliasManifestText);
    expect(uploadedByPath.has(COMMUNITY_PATH)).toBe(false);
    expect(state.setCommunityPluginEnablementState).not.toHaveBeenCalled();
  });
});
