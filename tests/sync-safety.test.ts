/**
 * Behavior tests for EasySync core sync safety (P0.1 / P0.2 / P0.3).
 *
 * These tests are the minimum safety net for the three data-loss vectors
 * identified in the high-tier model review. Each test maps to a specific
 * P0 fix commit.
 *
 * P0.1 (2776e59): Download always executes, even when local file exists
 * P0.2 (efcae57): Scan failures block destructive delete actions
 * P0.3 (72e19d6): Full SHA-256 catches modifications that quick hash missed
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import * as obsidian from "obsidian";
import { Platform, TFile, type Plugin } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { sameSyncScope, SyncActionType } from "../src/sync/types";
import { planDigest } from "../src/sync/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  ManualMutationResolutionV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import { generateFileDecisionPlanV2 } from "../src/sync/file-decision-planner-v2";
import { StateManager } from "../src/sync/state-manager";
import type { I18n } from "../src/i18n";
import { SyncProgressStore } from "../src/sync/sync-progress";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { EasySyncNoticeCenter } from "../src/ui/notice-center";
import {
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import {
  attachBaseAncestorHashesV2,
  projectStatePathViewV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";
import {
  makePublic113InterruptedUploadBatch,
  PUBLIC_113_NETWORK_RECOVERY_INCIDENT,
} from "./fixtures/network-recovery-incidents";
import { V2FilePlanTestHarness } from "./helpers/v2-file-plan-test-harness";
import type {
  CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";

// ---- Shared test helpers ----

const TEST_SYNC_SCOPE = {
  accountId: "",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};
const EASY_SYNC_TMP_DIR = getEasySyncPaths(".obsidian").tmpDir;

function makeMockAdapter(overrides: Record<string, unknown> = {}) {
  return {
    read: vi.fn().mockResolvedValue(""),
    write: vi.fn().mockResolvedValue(undefined),
    readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    appendBinary: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    stat: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeMockOneDrive(overrides: Record<string, unknown> = {}) {
  return {
    downloadBaseline: vi.fn().mockResolvedValue(null),
    downloadFile: vi.fn().mockImplementation(
      (_v: string, _p: string, _u?: string, _d?: string, s = 0, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        const buf = new ArrayBuffer(0);
        onProgress?.(buf.byteLength, s || buf.byteLength);
        return Promise.resolve(buf);
      },
    ),
    downloadFileToPath: vi.fn().mockImplementation(
      async (_v: string, _remotePath: string, _localPath: string, _adapter: unknown, _u?: string, _d?: string, s = 0, _sha?: string, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        onProgress?.(s, s);
        return { size: s, hash: "aa".repeat(32) };
      },
    ),
    uploadFile: vi.fn().mockResolvedValue({ id: "mock-upload-id", eTag: "mock-etag" }),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    initVaultScope: vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    }),
    restoreVaultScope: vi.fn().mockReturnValue(false),
    invalidateVaultScope: vi.fn(),
    isDeltaLinkForVault: vi.fn().mockReturnValue(true),
    resetDownloadStrategy: vi.fn(),
    setAbortSignal: vi.fn(),
    getFileMetadata: vi.fn().mockResolvedValue(null),
    getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
    getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "tok" }),
    fullScan: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as OneDriveClient;
}

function remoteStateStub() {
  return {
    hasRemoteState: false,
    remoteSnapshot: [] as RemoteFileEntry[],
    remoteFolders: [],
    remoteDeltaLink: null,
    remoteGeneration: 0,
    incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    setRemoteState: vi.fn().mockResolvedValue(undefined),
    clearRemoteState: vi.fn().mockResolvedValue(undefined),
    applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
    prunePendingIssues: vi.fn().mockResolvedValue(undefined),
    reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
    pendingIssues: [],
    cacheBaseContent: vi.fn(),
    getBaseContent: vi.fn().mockReturnValue(undefined),
    getBaseEntry: vi.fn((path: string) => undefined),
    mutationLedger: [],
    hasMutationLedgerCorruption: false,
    beginMutationIntent: vi.fn().mockResolvedValue(undefined),
    recordMutationReceipt: vi.fn().mockResolvedValue(undefined),
    abandonMutationIntent: vi.fn().mockResolvedValue(undefined),
    commitMutationCheckpoint: vi.fn().mockResolvedValue(undefined),
    commitMutationCheckpoints: vi.fn().mockResolvedValue(undefined),
  };
}

function makeActiveV2State(
  remoteEntries: RemoteFileEntry[],
  baseEntries: BaseFileEntry[],
  overrides: Record<string, unknown> = {},
): StateManager {
  const scope: SyncScope = {
    ...TEST_SYNC_SCOPE,
    accountId: "account-id",
  };
  let remoteFolders = (
    Array.isArray(overrides.remoteFolders)
      ? overrides.remoteFolders as RemoteFolderEntry[]
      : []
  ).map((entry) => ({ ...entry }));
  let remoteSnapshot = remoteEntries.map((entry) => ({
    parentId: entry.parentId ?? scope.filesRootId,
    ...entry,
  }));
  let baseSnapshot = baseEntries.map((entry) => ({ ...entry }));
  let manifestObservations: CommunityPluginManifestObservationV1[] = [];
  const pendingAncestorContent = new Map<string, string | ArrayBuffer>();
  let commitSeq = 1;
  let committedAt = 1;
  let envelope = createFileStateShadowEnvelopeV2({
    scope,
    lifecycleEpoch: 1,
    commitSeq,
    committedAt,
    remoteEntries: remoteSnapshot,
    remoteFolders,
    baseEntries: baseSnapshot,
  });
  envelope.remoteIndex.deltaLink = "delta-token";
  envelope.folderAnchors = {
    schemaVersion: 2,
    byAnchorId: {},
  };

  const state = {
    ...remoteStateStub(),
    legacyAutoSyncAllowed: false,
    isV2StateActive: true,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    hasMutationRecoveryQuarantineCorruption: false,
    boundAccountId: scope.accountId,
    hasRemoteState: true,
    hasCompleteRemoteFolderIndex: true,
    remoteSnapshot,
    remoteFolders,
    remoteDeltaLink: "delta-token",
    remoteScope: scope,
    baseSnapshot,
    localFolderMoveHints: [],
    planReviewActive: false,
    planReviewRevision: 0,
    planReviewScope: null,
    planReviewDigest: "",
    pendingConflicts: [],
    pendingRemoteDeletes: [],
    lastSyncTime: 1,
    acceptConfirmedDescendantFolderAnchors: vi.fn().mockResolvedValue({
      status: "none",
      accepted: 0,
      evidenceFiles: 0,
    }),
    prepareMutationRecoveryRecord: vi.fn((
      record: {
        intent: { scope: SyncScope };
      },
      currentScope: SyncScope,
    ) => sameSyncScope(record.intent.scope, currentScope) ? record : null),
    getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
    getBaseEntry: vi.fn((path: string) =>
      baseSnapshot.find((entry) => entry.path === path)),
    upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
    prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
    upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
    prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
    setLastSyncTime: vi.fn().mockResolvedValue(undefined),
    getCommunityPluginEnablementState: vi.fn((currentScope: SyncScope) => ({
      version: 1,
      scope: { ...currentScope },
      anchors: {},
      pending: [],
    })),
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
    remoteFolders,
  } as unknown as StateManager & {
    mutationLedger: Array<{
      intent: { operationId: string };
      receipt: { operationId: string } | null;
    }>;
    remoteSnapshot: RemoteFileEntry[];
    remoteFolders: RemoteFolderEntry[];
    remoteDeltaLink: string | null;
    remoteScope: SyncScope;
    baseSnapshot: BaseFileEntry[];
  };
  state.cacheBaseContent = vi.fn((
    path: string,
    content: string | ArrayBuffer,
  ) => {
    pendingAncestorContent.set(
      path,
      typeof content === "string" ? content : content.slice(0),
    );
  });

  state.setRemoteState = vi.fn(async (
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: SyncScope,
    folders: RemoteFolderEntry[] = [],
  ) => {
    remoteSnapshot = entries.map((entry) => ({
      parentId: entry.parentId ?? scope.filesRootId,
      ...entry,
    }));
    remoteFolders = folders.map((entry) => ({ ...entry }));
    commitSeq += 1;
    committedAt += 1;
    envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq,
      committedAt,
      remoteEntries: remoteSnapshot,
      remoteFolders,
      baseEntries: baseSnapshot,
    });
    envelope.remoteIndex.deltaLink = deltaLink;
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: {},
    };
    state.remoteSnapshot = remoteSnapshot;
    state.remoteFolders = remoteFolders;
    state.remoteDeltaLink = deltaLink;
    state.remoteScope = scope;
  });
  state.applyRemoteMutations = vi.fn(async (
    upserts: RemoteFileEntry[],
    deletedPaths: string[],
  ) => {
    const deleted = new Set(deletedPaths);
    const byPath = new Map(
      remoteSnapshot
        .filter((entry) => !deleted.has(entry.path))
        .map((entry) => [entry.path, entry]),
    );
    for (const entry of upserts) byPath.set(entry.path, entry);
    await state.setRemoteState(
      [...byPath.values()],
      state.remoteDeltaLink,
      state.remoteScope,
      state.remoteFolders,
    );
  });
  state.upsertBaseEntries = vi.fn(async (entries: BaseFileEntry[]) => {
    const ancestorHashes: Record<string, string> = {};
    for (const entry of entries) {
      const content = pendingAncestorContent.get(entry.path);
      if (content === undefined) continue;
      const bytes = typeof content === "string"
        ? new TextEncoder().encode(content).buffer
        : content;
      if (
        bytes.byteLength === entry.size
        && await sha256Hex(bytes) === entry.hash
      ) {
        ancestorHashes[entry.path] = entry.hash;
      }
    }
    const updates = new Map(entries.map((entry) => [entry.path, { ...entry }]));
    baseSnapshot = [
      ...baseSnapshot
        .filter((entry) => !updates.has(entry.path)),
      ...updates.values(),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const current = envelope;
    const nextCommittedAt = committedAt + 1;
    const baseCandidate = upsertBaseStateEnvelopeV2(
      current,
      entries,
      nextCommittedAt,
    );
    envelope = attachBaseAncestorHashesV2(
      current,
      baseCandidate,
      entries,
      ancestorHashes,
      nextCommittedAt,
    );
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    state.baseSnapshot = baseSnapshot;
    for (const entry of entries) pendingAncestorContent.delete(entry.path);
    return ancestorHashes;
  });
  state.setBaseSnapshot = vi.fn(async (entries: BaseFileEntry[]) => {
    baseSnapshot = entries.map((entry) => ({ ...entry }));
    envelope = replaceBaseStateEnvelopeV2(
      envelope,
      baseSnapshot,
      committedAt += 1,
    );
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    state.baseSnapshot = baseSnapshot;
  });
  state.removeBaseEntries = vi.fn(async (paths: string[]) => {
    const removals = new Set(paths);
    baseSnapshot = baseSnapshot.filter((entry) => !removals.has(entry.path));
    envelope = removeBaseStateEnvelopeV2(envelope, paths);
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    state.baseSnapshot = baseSnapshot;
  });
  state.beginMutationIntent = vi.fn(async (intent) => {
    state.mutationLedger.push({ intent, receipt: null });
  });
  state.recordMutationReceipt = vi.fn(async (receipt) => {
    const record = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === receipt.operationId,
    );
    if (!record) throw new Error(`Mutation intent missing: ${receipt.operationId}`);
    record.receipt = receipt;
  });
  state.abandonMutationIntent = vi.fn(async (operationId) => {
    const index = state.mutationLedger.findIndex(
      (record) => record.intent.operationId === operationId,
    );
    if (index >= 0) state.mutationLedger.splice(index, 1);
  });
  const applyMutationCheckpoint = (operationIds: readonly string[]) => {
    const records = operationIds.map((operationId) => {
      const record = state.mutationLedger.find(
        (candidate) => candidate.intent.operationId === operationId,
      );
      if (!record?.receipt) {
        throw new Error(`Mutation receipt missing: ${operationId}`);
      }
      return record;
    });
    const sourceCommitSeq = envelope.meta.commitSeq;
    for (const record of records) {
      envelope = reduceFileStateEnvelopeV2(envelope, record as never);
    }
    if (records.length > 1) {
      envelope = {
        ...envelope,
        meta: {
          ...envelope.meta,
          commitSeq: sourceCommitSeq + 1,
        },
      };
    }
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    const projection = projectStatePathViewV2(envelope);
    baseSnapshot = projection.baseEntries;
    remoteSnapshot = projection.remoteEntries;
    remoteFolders = projection.remoteFolders;
    state.baseSnapshot = baseSnapshot;
    state.remoteSnapshot = remoteSnapshot;
    state.remoteFolders = remoteFolders;
    state.remoteDeltaLink = projection.deltaLink;
    state.remoteScope = projection.scope;
    const operationIdSet = new Set(operationIds);
    state.mutationLedger.splice(
      0,
      state.mutationLedger.length,
      ...state.mutationLedger.filter(
        (record) => !operationIdSet.has(record.intent.operationId),
      ),
    );
    return {
      operations: records.length,
      ancestorPublishMs: 0,
      v2CommitMs: 0,
      ledgerClearMs: 0,
      totalMs: 0,
    };
  };
  state.commitMutationCheckpoint = vi.fn(async (operationId) => {
    return applyMutationCheckpoint([operationId]);
  });
  state.commitMutationCheckpoints = vi.fn(async (operationIds) => {
    return applyMutationCheckpoint(operationIds);
  });
  state.attachManualMutationResolution = vi.fn(async (
    expectedRecord: MutationLedgerEntryV1,
    resolution: ManualMutationResolutionV1,
  ) => {
    const record = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === expectedRecord.intent.operationId,
    ) as MutationLedgerEntryV1 | undefined;
    if (
      !record
      || record.manualResolution
      || JSON.stringify(record) !== JSON.stringify(expectedRecord)
    ) return false;
    record.manualResolution = structuredClone(resolution);
    return true;
  });
  state.recordManualMutationResolutionReceipt = vi.fn(async (
    sourceOperationId: string,
    receipt: MutationReceiptV1,
  ) => {
    const record = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === sourceOperationId,
    ) as MutationLedgerEntryV1 | undefined;
    if (!record?.manualResolution) throw new Error("manual resolution missing");
    record.manualResolution.receipt = structuredClone(receipt);
  });
  state.commitManualMutationResolutionCheckpoint = vi.fn(async (
    sourceOperationId: string,
  ) => {
    const index = state.mutationLedger.findIndex(
      (record) => record.intent.operationId === sourceOperationId,
    );
    const record = state.mutationLedger[index] as MutationLedgerEntryV1 | undefined;
    if (index < 0 || !record?.manualResolution?.receipt) {
      throw new Error(`Manual mutation receipt missing: ${sourceOperationId}`);
    }
    envelope = reduceFileStateEnvelopeV2(envelope, {
      intent: record.manualResolution.intent,
      receipt: record.manualResolution.receipt,
    });
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    const projection = projectStatePathViewV2(envelope);
    baseSnapshot = projection.baseEntries;
    remoteSnapshot = projection.remoteEntries;
    state.baseSnapshot = baseSnapshot;
    state.remoteSnapshot = remoteSnapshot;
    state.remoteFolders = projection.remoteFolders;
    state.remoteDeltaLink = projection.deltaLink;
    state.remoteScope = projection.scope;
    state.mutationLedger.splice(index, 1);
  });

  return state;
}

function graphFolder(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    folder: { childCount: 1 },
    parentReference: { id: parentId },
  };
}

describe("automatic non-overlapping text merge", () => {
  it("keeps a text conflict manual without downloading content when the option is off", async () => {
    const path = "note.md";
    const local: LocalFileEntry = {
      path,
      size: 5,
      mtime: 2,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 6,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: "cc".repeat(32),
    };
    const base: BaseFileEntry = {
      path,
      size: 4,
      hash: "bb".repeat(32),
      eTag: "etag-base",
    };
    const adapter = makeMockAdapter({
      readBinary: vi.fn().mockResolvedValue(new TextEncoder().encode("local").buffer),
    });
    const downloadFile = vi.fn().mockResolvedValue(new TextEncoder().encode("remote").buffer);
    const uploadFile = vi.fn().mockResolvedValue({ id: "merged-id", eTag: "etag-merged" });
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([remote], [base], {
      getBaseContent: vi.fn().mockReturnValue("base"),
      upsertPendingConflicts,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile, uploadFile }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
    );
    executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: false,
    });

    const result = await executor.run("manual", {});
    expect(result.conflicts).toBe(1);
    expect(result.message).toBe("result.conflictsPending");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        local,
        remote: expect.objectContaining(remote),
        reason: "reason.bothSidesModified",
        decisionToken: expect.objectContaining({
          version: 1,
          ancestorHash: base.hash,
        }),
      }),
    ]);
  });

  it("commits a verified clean merge through remote CAS, read-back, local replacement, and checkpoint", async () => {
    const path = "note.md";
    const baseText = "a\nb\nc\nd";
    const localText = "a\nlocal-b\nc\nd";
    let remoteText = "a\nb\nremote-c\nd";
    const baseBytes = new TextEncoder().encode(baseText).buffer;
    const localBytes = new TextEncoder().encode(localText).buffer;
    const baseHash = await sha256Hex(baseBytes);
    const localHash = await sha256Hex(localBytes);
    const files = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const texts = new Map<string, string>();
    let interruptedLocalCommit = false;
    const adapter = makeMockAdapter({
      read: vi.fn(async (target: string) => {
        const value = texts.get(target);
        if (value === undefined) throw new Error(`missing ${target}`);
        return value;
      }),
      write: vi.fn(async (target: string, value: string) => {
        texts.set(target, value);
      }),
      readBinary: vi.fn(async (target: string) => {
        const value = files.get(target);
        if (!value) throw new Error(`missing ${target}`);
        return value.slice(0);
      }),
      writeBinary: vi.fn(async (target: string, value: ArrayBuffer) => {
        files.set(target, value.slice(0));
      }),
      exists: vi.fn(async (target: string) => files.has(target) || texts.has(target)),
      stat: vi.fn(async (target: string) => {
        const binary = files.get(target);
        if (binary) return { size: binary.byteLength, mtime: 1 };
        const text = texts.get(target);
        return text === undefined
          ? null
          : { size: new TextEncoder().encode(text).byteLength, mtime: 1 };
      }),
      rename: vi.fn(async (source: string, target: string) => {
        if (!interruptedLocalCommit && source.endsWith(".merge-ready") && target === path) {
          interruptedLocalCommit = true;
          throw new Error("simulated interruption after remote merge commit");
        }
        if (files.has(source)) {
          files.set(target, files.get(source)!);
          files.delete(source);
          return;
        }
        if (texts.has(source)) {
          texts.set(target, texts.get(source)!);
          texts.delete(source);
          return;
        }
        throw new Error(`missing ${source}`);
      }),
      remove: vi.fn(async (target: string) => {
        files.delete(target);
        texts.delete(target);
      }),
    });
    const inspectFile = vi.fn(async () => {
      const bytes = files.get(path);
      if (!bytes) return { status: "missing" as const };
      return {
        status: "present" as const,
        entry: {
          path,
          size: bytes.byteLength,
          mtime: 1,
          hash: await sha256Hex(bytes),
          binary: false,
        },
      };
    });
    let remoteETag = "etag-remote";
    const downloadFile = vi.fn(async () => new TextEncoder().encode(remoteText).buffer);
    const uploadFile = vi.fn(async (
      _vault: string,
      _path: string,
      content: ArrayBuffer,
      _progress?: unknown,
      eTag?: string,
      driveId?: string,
    ) => {
      expect(eTag).toBe("etag-remote");
      expect(driveId).toBe("remote-note");
      remoteText = new TextDecoder().decode(content);
      remoteETag = "etag-merged";
      return {
        id: "remote-note",
        name: "note.md",
        size: content.byteLength,
        eTag: remoteETag,
        parentReference: { id: "files-root-id" },
      };
    });
    const getFileMetadata = vi.fn(async () => {
      const bytes = new TextEncoder().encode(remoteText).buffer;
      return {
        driveId: "remote-note",
        parentId: "files-root-id",
        downloadUrl: "remote-url",
        size: bytes.byteLength,
        mtime: 1,
        eTag: remoteETag,
        sha256Hash: await sha256Hex(bytes),
      };
    });
    const local: LocalFileEntry = {
      path,
      size: localBytes.byteLength,
      mtime: 1,
      hash: localHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-note",
      parentId: "files-root-id",
      downloadUrl: "remote-url",
      size: new TextEncoder().encode(remoteText).byteLength,
      mtime: 1,
      eTag: remoteETag,
      cTag: "ctag-remote",
      sha256Hash: await sha256Hex(
        new TextEncoder().encode(remoteText).buffer,
      ),
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{ path, hash: baseHash, size: baseBytes.byteLength, eTag: "etag-base" }],
      {
      getBaseEntry: vi.fn().mockReturnValue({
        path,
        hash: baseHash,
        size: baseBytes.byteLength,
        eTag: "etag-base",
      }),
      getBaseContent: vi.fn().mockReturnValue(baseText),
      upsertPendingConflicts,
      },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile, uploadFile, getFileMetadata }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const onFileComplete = vi.fn();
    let changedPolicyDuringRun = false;
    const result = await executor.run("manual", {
      onFileComplete,
      onProgress: () => {
        if (changedPolicyDuringRun) return;
        changedPolicyDuringRun = true;
        executor.setAutomaticHandlingPolicy({
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: false,
        });
      },
    });
    expect(result.conflicts).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.metrics?.automaticHandling.textMerge).toMatchObject({
      candidates: 1,
      completed: 1,
      keptManual: 0,
      failed: 0,
      cancelled: 0,
      manualReasons: {},
    });
    expect(result.metrics?.automaticHandling.mergeRecovery).toMatchObject({
      records: 0,
      remoteCommittedLocalRecovered: 0,
      remoteCommittedLocalPending: 0,
    });
    expect(changedPolicyDuringRun).toBe(true);
    expect(interruptedLocalCommit).toBe(true);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(onFileComplete).toHaveBeenCalledWith(
      path,
      SyncActionType.Upload,
      true,
      expect.any(String),
      files.get(path)!.byteLength,
    );
    expect(remoteText).toBe("a\nlocal-b\nremote-c\nd");
    expect(new TextDecoder().decode(files.get(path))).toBe(remoteText);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseUpserts: [expect.objectContaining({ path, hash: await sha256Hex(files.get(path)!) })],
        remoteUpserts: [expect.objectContaining({ path, driveId: "remote-note", eTag: "etag-merged" })],
      }),
    }));
  });

  it.each([
    "reason.newFileBothSides",
    "reason.bothSidesModified",
  ])("always converges byte-identical %s conflicts", async (reason) => {
    const hash = "ab".repeat(32);
    const local: LocalFileEntry = {
      path: "same.md",
      size: 4,
      mtime: 2,
      hash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-same",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: hash,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      reason === "reason.bothSidesModified"
        ? [{ path: local.path, hash: "cd".repeat(32), size: local.size, eTag: "etag-base" }]
        : [],
      { upsertPendingConflicts },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});
    expect(result.conflicts).toBe(0);
    expect(state.upsertBaseEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: local.path, hash }),
    ]);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
  });
});

describe("device-local sync scope projection", () => {
  it("passes only in-scope durable base entries to planning", async () => {
    const includedBase: BaseFileEntry = {
      path: "keep.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-keep",
    };
    const excludedBase: BaseFileEntry = {
      path: "Private.drop.md",
      hash: "bb".repeat(32),
      size: 11,
      eTag: "etag-drop",
    };
    const includedLocal: LocalFileEntry = {
      path: includedBase.path,
      size: includedBase.size,
      mtime: 1,
      hash: includedBase.hash,
      binary: false,
    };
    const excludedLocal: LocalFileEntry = {
      path: excludedBase.path,
      size: excludedBase.size,
      mtime: 1,
      hash: excludedBase.hash,
      binary: false,
    };
    const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [],
      [includedBase, excludedBase],
      { upsertPendingDeletes },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [includedLocal, excludedLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        shouldSyncPath: vi.fn((path: string) => !path.startsWith("Private")),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    const pendingDeletes = upsertPendingDeletes.mock.calls.flatMap(
      ([items]) => items as SyncPlanItem[],
    );
    expect(pendingDeletes).toEqual([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: includedBase.path,
      }),
    ]);
  });
});

// ---- P0.3: Full SHA-256 hash correctness ----

describe("P0.3 — sha256Hex (full SHA-256)", () => {
  it("same content produces same hash", async () => {
    const data = new TextEncoder().encode("hello world").buffer;
    const h1 = await sha256Hex(data);
    const h2 = await sha256Hex(data);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different content produces different hash", async () => {
    const a = new TextEncoder().encode("hello world").buffer;
    const b = new TextEncoder().encode("hello worlD").buffer;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("modification beyond 16KB is detected (old quickHash blind spot)", async () => {
    const size = 20 * 1024;
    const buf1 = new Uint8Array(size);
    const buf2 = new Uint8Array(size);
    for (let i = 0; i < 16 * 1024; i++) {
      buf1[i] = buf2[i] = i % 256;
    }
    buf2[size - 1] = 0xff;

    const h1 = await sha256Hex(buf1.buffer);
    const h2 = await sha256Hex(buf2.buffer);
    expect(h1).not.toBe(h2);
  });

  it("0-byte file hash matches known SHA-256 empty input", async () => {
    const empty = new ArrayBuffer(0);
    const h = await sha256Hex(empty);
    expect(h).toHaveLength(64);
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("same-size entirely different content produces different hash", async () => {
    const buf1 = new Uint8Array(1000).fill(0x41);
    const buf2 = new Uint8Array(1000).fill(0x42);
    expect(await sha256Hex(buf1.buffer)).not.toBe(await sha256Hex(buf2.buffer));
  });
});

// ---- P0.2: Incomplete local scan stops the whole round ----
// Tests the REAL production path via SyncExecutor.run(), not a copied helper.

describe("P0.2 — incomplete local scan causes zero mutation (real executor)", () => {
  async function runWithV2Facts(
    facts: {
      localEntries?: LocalFileEntry[];
      remoteEntries?: RemoteFileEntry[];
      baseEntries?: BaseFileEntry[];
      failedPaths?: string[];
      complete?: boolean;
      stableFillerCount?: number;
    },
    options: {
      autoDeleteLocalFiles?: boolean;
      inspectFile?: ReturnType<typeof vi.fn>;
      getFileMetadata?: ReturnType<typeof vi.fn>;
      adapterOverrides?: Record<string, unknown>;
      recordMutationReceipt?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const fillerBaseEntries = Array.from(
      { length: facts.stableFillerCount ?? 0 },
      (_, index): BaseFileEntry => ({
        path: `stable-${index}.md`,
        hash: `${index.toString(16).padStart(2, "0")}`.repeat(32),
        size: 10,
        eTag: `etag-stable-${index}`,
      }),
    );
    const fillerLocalEntries = fillerBaseEntries.map(
      (entry): LocalFileEntry => ({
        path: entry.path,
        hash: entry.hash,
        size: entry.size,
        mtime: 1,
        binary: false,
      }),
    );
    const fillerRemoteEntries = fillerBaseEntries.map(
      (entry, index): RemoteFileEntry => ({
        path: entry.path,
        driveId: `remote-stable-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: entry.size,
        mtime: 1,
        eTag: entry.eTag,
        cTag: `ctag-stable-${index}`,
        sha256Hash: entry.hash,
      }),
    );
    const localEntries = [
      ...(facts.localEntries ?? []),
      ...fillerLocalEntries,
    ];
    const remoteEntries = [
      ...(facts.remoteEntries ?? []),
      ...fillerRemoteEntries,
    ];
    const baseEntries = [
      ...(facts.baseEntries ?? []),
      ...fillerBaseEntries,
    ];
    const failedPaths = facts.failedPaths ?? [];
    const complete = facts.complete ?? failedPaths.length === 0;
    const mockDeleteItem = vi.fn().mockResolvedValue(undefined);
    const mockDownloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(1));
    const mockInitVaultScope = vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const mockUpsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const mockPrunePendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockPrunePendingDeletes = vi.fn().mockResolvedValue(undefined);
    const mockSetLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const mockGetDelta = vi.fn().mockResolvedValue({
      value: remoteEntries.map((entry) => ({
        id: entry.driveId,
        name: entry.path,
        size: entry.size,
        eTag: entry.eTag,
        cTag: entry.cTag,
        parentReference: {
          id: entry.parentId ?? TEST_SYNC_SCOPE.filesRootId,
        },
        lastModifiedDateTime: new Date(entry.mtime).toISOString(),
        file: {
          hashes: {
            ...(entry.sha256Hash
              ? { sha256Hash: entry.sha256Hash }
              : {}),
            ...(entry.quickXorHash
              ? { quickXorHash: entry.quickXorHash }
              : {}),
          },
        },
      })),
      "@odata.deltaLink": "tok",
    });

    const mockOneDrive = makeMockOneDrive({
      deleteItem: mockDeleteItem,
      downloadFile: mockDownloadFile,
      initVaultScope: mockInitVaultScope,
      getFileMetadata: options.getFileMetadata ?? vi.fn().mockResolvedValue(null),
      getDelta: mockGetDelta,
    });

    const mockAdapter = makeMockAdapter(options.adapterOverrides);
    const mockScanner = {
      vault: {
        adapter: mockAdapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        getFileByPath: vi.fn().mockReturnValue(null),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: localEntries,
        folders: [],
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        failedPaths,
        skippedCount: 0,
        complete,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      inspectFile: options.inspectFile ?? vi.fn(async (path: string) => {
        const entry = localEntries.find((candidate) => candidate.path === path);
        return entry
          ? { status: "present" as const, entry }
          : { status: "missing" as const };
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mutationState = makeActiveV2State(remoteEntries, baseEntries, {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: mockPrunePendingConflicts,
      upsertPendingDeletes: mockUpsertPendingDeletes,
      prunePendingDeletes: mockPrunePendingDeletes,
      setLastSyncTime: mockSetLastSyncTime,
    });
    if (options.recordMutationReceipt) {
      mutationState.recordMutationReceipt = options.recordMutationReceipt;
    }

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mutationState,
      "testVault",
    );
    executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: options.autoDeleteLocalFiles ?? false,
      mergeNonOverlappingText: true,
    });

    const result = await executor.run("manual", {});

    return {
      result,
      mockDeleteItem,
      mockDownloadFile,
      mockInitVaultDirectories: mockInitVaultScope,
      mockUpsertPendingDeletes,
      mockPrunePendingConflicts,
      mockPrunePendingDeletes,
      mockSetLastSyncTime,
      mockGetDelta,
      mockAdapter,
      mutationState,
    };
  }

  function base(path: string): BaseFileEntry {
    return {
      path,
      hash: "aa".repeat(32),
      size: 10,
      eTag: `etag-${path}`,
    };
  }

  function local(entry: BaseFileEntry): LocalFileEntry {
    return {
      path: entry.path,
      size: entry.size,
      mtime: 1,
      hash: entry.hash,
      binary: false,
    };
  }

  function remote(entry: BaseFileEntry): RemoteFileEntry {
    return {
      path: entry.path,
      driveId: `id-${entry.path}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: entry.size,
      mtime: 1,
      eTag: entry.eTag,
      cTag: `ctag-${entry.path}`,
      sha256Hash: entry.hash,
    };
  }

  it("blocks DeleteRemote — deleteItem is never called when scan unhealthy", async () => {
    const a = base("a.md");
    const b = base("b.md");
    const { mockDeleteItem } = await runWithV2Facts({
      baseEntries: [a, b],
      remoteEntries: [remote(a), remote(b)],
      failedPaths: ["failed.txt"],
    });
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it("blocks ConfirmLocalDelete — pending delete batch stays empty when scan unhealthy", async () => {
    const deletedRemotely = base("c.md");
    const { mockUpsertPendingDeletes } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [local(deletedRemotely)],
      failedPaths: ["failed.txt"],
    });
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
  });

  it("reports scan failures without generating or executing a plan", async () => {
    const x = base("x.md");
    const y = base("y.md");
    const {
      result,
      mockGetDelta,
      mockInitVaultDirectories,
      mutationState,
    } = await runWithV2Facts({
      baseEntries: [x, y],
      remoteEntries: [remote(x), remote(y)],
      failedPaths: ["failed.txt"],
    });
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGetDelta).not.toHaveBeenCalled();
    expect(mockInitVaultDirectories).not.toHaveBeenCalled();
    expect(mutationState.getCommittedV2Envelope).not.toHaveBeenCalled();
  });

  it("allows DeleteRemote when scan is healthy (no failed paths)", async () => {
    const deletedLocally = base("safe.md");
    const { mockDeleteItem } = await runWithV2Facts({
      baseEntries: [deletedLocally],
      remoteEntries: [remote(deletedLocally)],
      stableFillerCount: 9,
    });
    expect(mockDeleteItem).toHaveBeenCalled();
  });

  it("allows ConfirmLocalDelete when scan is healthy", async () => {
    const deletedRemotely = base("safe.md");
    const localEntry = local(deletedRemotely);
    const { mockUpsertPendingDeletes } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    });
    expect(mockUpsertPendingDeletes).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: deletedRemotely.path,
        local: localEntry,
        reason: "reason.fileDeletedFromRemote",
        decisionToken: expect.objectContaining({ version: 1 }),
      }),
    ]);
  });

  it("counts a merge candidate kept manual when no trusted ancestor is available", async () => {
    const path = "manual-merge.md";
    const common: BaseFileEntry = {
      path,
      size: 4,
      hash: "bb".repeat(32),
      eTag: "etag-base",
    };
    const localEntry: LocalFileEntry = {
      path,
      size: 5,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remoteEntry: RemoteFileEntry = {
      path,
      driveId: "remote-manual-merge",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 6,
      mtime: 2,
      eTag: "etag-manual-merge",
      cTag: "ctag-manual-merge",
      sha256Hash: "cc".repeat(32),
    };
    const { result, mockDownloadFile } = await runWithV2Facts({
      baseEntries: [common],
      localEntries: [localEntry],
      remoteEntries: [remoteEntry],
    });

    expect(result.conflicts).toBe(1);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(result.metrics?.automaticHandling.textMerge).toMatchObject({
      candidates: 1,
      completed: 0,
      keptManual: 1,
      failed: 0,
      manualReasons: { "ancestor-unavailable": 1 },
    });
  });

  it("executes an authorized local delete through the cleanup mutation checkpoint", async () => {
    const deletedRemotely = base("auto-delete.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn().mockResolvedValue({
      status: "present",
      entry: localEntry,
    });
    const {
      result,
      mockAdapter,
      mutationState,
      mockUpsertPendingDeletes,
      mockPrunePendingDeletes,
    } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile,
      adapterOverrides: { remove },
    });

    expect(result.deleted).toBe(1);
    expect(result.metrics?.automaticHandling.deleteLocal).toEqual({
      candidates: 1,
      completed: 1,
      failed: 0,
    });
    expect(mockAdapter.remove).toHaveBeenCalledWith(deletedRemotely.path);
    expect(mockPrunePendingDeletes).toHaveBeenCalledWith([deletedRemotely.path]);
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
    expect(mutationState.beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: "deleteLocal",
      path: deletedRemotely.path,
      expectedLocal: {
        exists: true,
        hash: localEntry.hash,
        size: localEntry.size,
      },
      expectedRemote: { exists: false },
    }));
    expect(mutationState.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseRemovals: [deletedRemotely.path],
        pendingDeleteRemovals: [deletedRemotely.path],
      }),
    }));
    expect(mutationState.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the local version changed before an automatic delete", async () => {
    const deletedRemotely = base("changed.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...localEntry, hash: "bb".repeat(32) },
      }),
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(1);
    expect(result.metrics?.automaticHandling.deleteLocal).toEqual({
      candidates: 1,
      completed: 0,
      failed: 1,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.recordMutationReceipt).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mutationState.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(mutationState.mutationLedger).toEqual([]);
    expect(mutationState.reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: deletedRemotely.path,
        actionType: SyncActionType.DeleteLocal,
        reason: "syncView.failure.localChangedBeforeDelete",
      })],
      new Set(),
    );
  });

  it("fails closed when the remote file reappeared before an automatic delete", async () => {
    const deletedRemotely = base("restored-remotely.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn();
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "remote-restored",
        size: localEntry.size,
        mtime: 2,
        eTag: "etag-restored",
      }),
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(1);
    expect(inspectFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mutationState.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(mutationState.mutationLedger).toEqual([]);
  });

  it("does not publish a checkpoint when receipt persistence fails after deletion", async () => {
    const deletedRemotely = base("receipt-failure.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockRejectedValue(new Error("receipt unavailable"));
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: localEntry,
      }),
      adapterOverrides: { remove },
      recordMutationReceipt,
    });

    expect(remove).toHaveBeenCalledWith(deletedRemotely.path);
    expect(result.errors).toBe(1);
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("blocks downloads and state cleanup as well as destructive actions", async () => {
    const remoteOnly: RemoteFileEntry = {
      path: "b.md",
      driveId: "id-b",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "etag-b",
      cTag: "ctag-b",
      sha256Hash: "bb".repeat(32),
    };
    const {
      result,
      mockDownloadFile,
      mockPrunePendingConflicts,
      mockPrunePendingDeletes,
      mockSetLastSyncTime,
    } = await runWithV2Facts({
      remoteEntries: [remoteOnly],
      failedPaths: ["failed.txt"],
    });
    expect(result.errors).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockPrunePendingConflicts).not.toHaveBeenCalled();
    expect(mockPrunePendingDeletes).not.toHaveBeenCalled();
    expect(mockSetLastSyncTime).not.toHaveBeenCalled();
  });

  it("stops when the scanner reports incomplete without path detail", async () => {
    const unknown = base("unknown.md");
    const {
      result,
      mockGetDelta,
      mockInitVaultDirectories,
    } = await runWithV2Facts({
      baseEntries: [unknown],
      remoteEntries: [remote(unknown)],
      complete: false,
    });

    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGetDelta).not.toHaveBeenCalled();
    expect(mockInitVaultDirectories).not.toHaveBeenCalled();
  });
});

describe("D7 read-only preview contract", () => {
  it("uses GET-only scope preparation and cannot execute even if preview confirms", async () => {
    const local: LocalFileEntry = {
      path: "preview-only.md",
      size: 7,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({ id: "uploaded", eTag: "etag-new" });
    const initVaultScope = vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const adapter = makeMockAdapter();
    const state = makeActiveV2State([], []);
    const onFirstSyncPreview = vi.fn().mockResolvedValue(true);
    const executor = new SyncExecutor(
      makeMockOneDrive({ initVaultScope, uploadFile }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run(
      "first",
      { onFirstSyncPreview },
      false,
      undefined,
      { readOnlyPreview: true },
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(initVaultScope).toHaveBeenCalledWith("testVault", { createMissing: false });
    expect(onFirstSyncPreview).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });
});

describe("M17 circuit breaker retry semantics", () => {
  function makeBreakerExecutor(
    mode: "manual" | "auto",
    pendingActionType = SyncActionType.Download,
  ) {
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const remote: RemoteFileEntry = {
      path: "stuck.m4a",
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-stuck",
      cTag: "ctag-stuck",
    };
    const mockState = makeActiveV2State([remote], [], {
      pendingIssues: [{
        path: remote.path,
        actionType: pendingActionType,
        reason: "syncView.failure.contentUnavailable",
        updatedAt: 1,
        fileSize: remote.size,
        remoteETag: remote.eTag,
        consecutiveFailures: 3,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: remote.driveId,
          parentId: remote.parentId,
          size: remote.size,
          mtime: remote.mtime,
          eTag: remote.eTag,
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    return { executor, downloadFile, mode };
  }

  it("manual sync bypasses the stale breaker and retries the file", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("manual");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("auto sync still keeps the breaker guardrail", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("auto");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(0);
    expect(result.errors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("does not treat an earlier user-decision deferral as a transfer failure", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor(
      "auto",
      SyncActionType.FolderDeferred,
    );

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });
});

// ---- Pre-implementation safety evidence: download compare-and-swap ----
describe("Preflight P0 — Download never overwrites a path that changed after scan", () => {
  it("does not overwrite a remote-only path created after the scan", async () => {
    const buf16 = new ArrayBuffer(16);
    const mockDownloadFile = vi.fn().mockImplementation(
      (_v: string, _p: string, _u?: string, _d?: string, s = 0, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        onProgress?.(buf16.byteLength, s || buf16.byteLength);
        return Promise.resolve(buf16);
      },
    );
    const mockWriteBinary = vi.fn().mockResolvedValue(undefined);
    const mockScanFile = vi.fn().mockResolvedValue({
      path: "test.md",
      hash: "abcd1234".repeat(8),
      size: 16,
    });

    const mockOneDrive = makeMockOneDrive({
      downloadFile: mockDownloadFile,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });
    const remote: RemoteFileEntry = {
      path: "test.md",
      driveId: "item123",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://example.com/dl",
      size: buf16.byteLength,
      mtime: Date.now(),
      eTag: "etag1",
      cTag: "ctag1",
      sha256Hash: await sha256Hex(buf16),
    };

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: mockScanFile,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: await mockScanFile(),
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mockState = makeActiveV2State([remote], [], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
    });
    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
      undefined,
      undefined,
    );

    await executor.run("manual", {
    });

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockWriteBinary).not.toHaveBeenCalled();
    expect(mockState.addPendingConflict).toHaveBeenCalledTimes(1);
  });

  it("routes a same-path new file on both sides to conflict without downloading", async () => {
    const mockDownloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(32));
    const mockWriteBinary = vi.fn().mockResolvedValue(undefined);

    const mockOneDrive = makeMockOneDrive({
      downloadFile: mockDownloadFile,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });
    const remote: RemoteFileEntry = {
      path: "existing.md",
      driveId: "item456",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://example.com/dl2",
      size: 32,
      mtime: Date.now() + 10000,
      eTag: "etag2",
      cTag: "ctag2",
      sha256Hash: "22".repeat(32),
    };

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [
          {
            path: "existing.md",
            size: 100,
            mtime: 1,
            hash: "11".repeat(32),
            binary: false,
          },
        ],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue({
        path: "existing.md",
        hash: "newhash".repeat(8),
        size: 32,
      }),
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: {
          path: "existing.md",
          hash: "newhash".repeat(8),
          size: 32,
          mtime: 2,
          binary: false,
        },
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([remote], [], {
      upsertPendingConflicts,
    });

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
    );

    await executor.run("manual", {});

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockWriteBinary).not.toHaveBeenCalled();
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: remote.path,
        reason: "reason.newFileBothSides",
      }),
    ]);
  });

  it("stops after the network download when a remote-only path appears before the write", async () => {
    const path = "created-during-download.md";
    const downloaded = new Uint8Array([7, 7, 7]).buffer;
    const created: LocalFileEntry = {
      path,
      hash: await sha256Hex(new Uint8Array([9, 9, 9]).buffer),
      size: 3,
      mtime: 2,
      binary: false,
    };
    const inspectFile = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "present", entry: created });
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: downloaded.byteLength,
      mtime: 1,
      eTag: "etag",
      cTag: "ctag",
      sha256Hash: await sha256Hex(downloaded),
    };
    const state = makeActiveV2State([remote], [], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(state.addPendingConflict).toHaveBeenCalledTimes(1);
    expect(result.conflicts).toBe(1);
  });
});

describe("Cloud baseline bootstrap safety", () => {
  it("accepts a V1 cloud baseline only when exact content or its bound remote version matches", () => {
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {} as LocalScanner,
      {} as StateManager,
      "testVault",
    );
    const seed = (executor as unknown as {
      seedBaseEntriesFromCloudBaseline(
        json: string,
        local: LocalFileEntry[],
        remote: RemoteFileEntry[],
      ): BaseFileEntry[];
    }).seedBaseEntriesFromCloudBaseline.bind(executor);
    const json = JSON.stringify({
      vaultName: "testVault",
      lastSyncAt: 1,
      files: { "note.md": { hash: "aa".repeat(32), size: 4, eTag: "old", mtime: 0 } },
    });
    const local: LocalFileEntry[] = [{
      path: "note.md", hash: "aa".repeat(32), size: 4, mtime: 1, binary: false,
    }];
    const remote: RemoteFileEntry = {
      path: "note.md", driveId: "id", size: 4, mtime: 1, eTag: "old", cTag: "c",
    };

    expect(seed(json, local, [remote])).toEqual([{
      path: "note.md", hash: "aa".repeat(32), size: 4, eTag: "old",
    }]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      quickXorHash: "same-quickxor-is-not-exact-proof",
    }])).toEqual([]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      sha256Hash: "bb".repeat(32),
    }])).toEqual([]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      sha256Hash: "aa".repeat(32),
    }])).toEqual([{
      path: "note.md", hash: "aa".repeat(32), size: 4, eTag: "current",
    }]);
  });

  it("persists and consumes a V2 cTag-bound cloud bootstrap before canonical planning", async () => {
    const path = "note.md";
    const content = new TextEncoder().encode("same V2 bootstrap content").buffer;
    const hash = await sha256Hex(content);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const downloadBaseline = vi.fn().mockResolvedValue(null);
    const syncScope = {
      accountId: "account-id",
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };
    const bootstrap = JSON.stringify({
      schemaVersion: 2,
      scope: syncScope,
      revision: 1,
      sourceCommitSeq: 1,
      generatedAt: 1,
      anchors: [{
        remoteId: "note-id",
        lastPath: path,
        contentHash: hash,
        size: content.byteLength,
        remoteETag: "etag-v2",
        remoteCTag: "ctag-v2",
      }],
    });
    const mockState = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        readCloudBootstrapV2: vi.fn().mockResolvedValue({
          id: "bootstrap-id",
          eTag: "bootstrap-etag",
          content: bootstrap,
        }),
        downloadBaseline,
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "note-id",
            name: path,
            size: content.byteLength,
            eTag: "etag-v2",
            cTag: "ctag-v2",
            parentReference: { id: syncScope.filesRootId },
            file: {
              hashes: {
                quickXorHash: "provider-quickxor",
              },
            },
          }],
          "@odata.deltaLink": "tok",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path,
            size: content.byteLength,
            mtime: 1,
            hash,
            quickXorHash: "provider-quickxor",
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({ success: true, downloaded: 0, conflicts: 0 });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadBaseline).not.toHaveBeenCalled();
    expect(mockState.baseSnapshot).toEqual([{
      path,
      hash,
      size: content.byteLength,
      eTag: "etag-v2",
    }]);
  });

  it("active V2 with a remote-only file downloads it without legacy baseline fallback", async () => {
    const deleteItem = vi.fn();
    const downloaded = new ArrayBuffer(12);
    const downloadedHash = await sha256Hex(downloaded);
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const downloadBaseline = vi.fn().mockResolvedValue(JSON.stringify({
      vaultName: "testVault",
      lastSyncAt: 123,
      files: {
        "note.md": {
          hash: "aa".repeat(32),
          size: 12,
          eTag: "etag-remote",
          mtime: 0,
        },
      },
    }));
    const files = new Map<string, ArrayBuffer>();
    const writeBinary = vi.fn(async (target: string, content: ArrayBuffer) => {
      files.set(target, content.slice(0));
    });
    const adapter = makeMockAdapter({
      writeBinary,
      exists: vi.fn().mockImplementation(async (target: string) =>
        files.has(target)),
      stat: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value ? { size: value.byteLength, mtime: 1 } : null;
      }),
      readBinary: vi.fn().mockImplementation(async (target: string) =>
        files.get(target)?.slice(0) ?? new ArrayBuffer(0)),
      rename: vi.fn().mockImplementation(async (
        source: string,
        target: string,
      ) => {
        const value = files.get(source);
        if (!value) throw new Error(`missing ${source}`);
        files.set(target, value);
        files.delete(source);
      }),
      remove: vi.fn().mockImplementation(async (target: string) => {
        files.delete(target);
      }),
    });

    const mockOneDrive = makeMockOneDrive({
      downloadBaseline,
      downloadFile,
      deleteItem,
      uploadFile: vi.fn(),
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      getDelta: vi.fn().mockResolvedValue({
        value: [
          {
            id: "item-note",
            name: "note.md",
            size: 12,
            eTag: "etag-remote",
            cTag: "ctag-remote",
            lastModifiedDateTime: "2026-07-08T00:00:00.000Z",
            parentReference: {
              id: "files-root-id",
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: downloadedHash } },
          },
        ],
        "@odata.deltaLink": "tok",
      }),
    });

    const mockScanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [] as LocalFileEntry[],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue({
        path: "note.md",
        hash: "bb".repeat(32),
        size: 12,
        mtime: 1,
        binary: false,
      }),
      inspectFile: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value
          ? {
            status: "present",
            entry: {
              path: target,
              hash: await sha256Hex(value),
              size: value.byteLength,
              mtime: 1,
              binary: false,
            },
          }
          : { status: "missing" };
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mockState = makeActiveV2State([], []);

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    expect(downloadBaseline).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      "note.md",
      undefined,
      "item-note",
      12,
      undefined,
    );
    expect(writeBinary).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/note.md.part.ready`,
      expect.any(ArrayBuffer),
    );
    expect(adapter.rename).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/note.md.part.ready`,
      "note.md",
    );
    expect(await sha256Hex(files.get("note.md")!)).toBe(downloadedHash);
  });

  it.each([
    {
      name: "rewrites an Android temp file in place when its first creation is empty",
      emptyWrites: 1,
      expectedWrites: 2,
      succeeds: true,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "fails closed after three Android temp rewrites still verify empty",
      emptyWrites: 3,
      expectedWrites: 3,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "does not retry an Android writeBinary exception",
      emptyWrites: 0,
      expectedWrites: 1,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: true,
      corruptWrites: 0,
    },
    {
      name: "does not retry a non-empty Android hash mismatch",
      emptyWrites: 0,
      expectedWrites: 1,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 1,
    },
    {
      name: "does not broaden the Android rewrite workaround to iOS",
      emptyWrites: 1,
      expectedWrites: 1,
      succeeds: false,
      android: false,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "does not broaden the Android rewrite workaround to desktop",
      emptyWrites: 1,
      expectedWrites: 1,
      succeeds: false,
      android: false,
      mobile: false,
      writeFails: false,
      corruptWrites: 0,
    },
  ])("$name", async ({
    android,
    mobile,
    emptyWrites,
    expectedWrites,
    succeeds,
    writeFails,
    corruptWrites,
  }) => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    const previousAndroid = Platform.isAndroidApp;
    Platform.isMobile = mobile;
    Platform.isDesktop = !mobile;
    Platform.isAndroidApp = android;
    const path = "android-retry.md";
    const readyPath = `${EASY_SYNC_TMP_DIR}/downloads/android-retry.md.part.ready`;
    const downloaded = new TextEncoder().encode("android temp retry").buffer;
    const downloadedHash = await sha256Hex(downloaded);
    const files = new Map<string, ArrayBuffer>();
    let readyWrites = 0;
    const writeBinary = vi.fn(async (target: string, content: ArrayBuffer) => {
      readyWrites++;
      if (writeFails && readyWrites === 1) throw new Error("writeBinary failed");
      if (readyWrites <= emptyWrites) {
        files.set(target, new ArrayBuffer(0));
      } else if (readyWrites <= emptyWrites + corruptWrites) {
        const corrupted = new Uint8Array(content.slice(0));
        corrupted[0] ^= 0xff;
        files.set(target, corrupted.buffer);
      } else {
        files.set(target, content.slice(0));
      }
    });
    const rename = vi.fn(async (source: string, target: string) => {
      const content = files.get(source);
      if (!content) throw new Error(`missing ${source}`);
      files.set(target, content);
      files.delete(source);
    });
    const adapter = makeMockAdapter({
      writeBinary,
      rename,
      exists: vi.fn(async (target: string) => files.has(target)),
      stat: vi.fn(async (target: string) => {
        const content = files.get(target);
        return content ? { size: content.byteLength, mtime: 1 } : null;
      }),
      readBinary: vi.fn(async (target: string) => {
        const content = files.get(target);
        if (!content) throw new Error(`missing ${target}`);
        return content.slice(0);
      }),
      remove: vi.fn(async (target: string) => {
        files.delete(target);
      }),
    });
    const remote: RemoteFileEntry = {
      path,
      driveId: "android-retry-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: downloaded.byteLength,
      mtime: 1,
      eTag: "android-retry-etag",
      cTag: "android-retry-ctag",
      sha256Hash: downloadedHash,
    };
    const state = makeActiveV2State([remote], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile: vi.fn().mockResolvedValue(downloaded) }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (target: string) => {
          const content = files.get(target);
          return content
            ? {
              status: "present",
              entry: {
                path: target,
                hash: await sha256Hex(content),
                size: content.byteLength,
                mtime: 1,
                binary: false,
              },
            }
            : { status: "missing" };
        }),
        getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});

      expect(result).toMatchObject(succeeds
        ? { success: true, downloaded: 1, errors: 0 }
        : { success: false, downloaded: 0, errors: 1 });
      expect(writeBinary).toHaveBeenCalledTimes(expectedWrites);
      expect(writeBinary).toHaveBeenNthCalledWith(1, readyPath, downloaded);
      if (succeeds) {
        expect(writeBinary).toHaveBeenNthCalledWith(2, readyPath, downloaded);
        expect(rename).toHaveBeenCalledWith(readyPath, path);
        expect(await sha256Hex(files.get(path)!)).toBe(downloadedHash);
        expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
        expect(state.baseSnapshot).toEqual([
          expect.objectContaining({ path, hash: downloadedHash, size: downloaded.byteLength }),
        ]);
      } else {
        expect(rename).not.toHaveBeenCalled();
        expect(files.has(path)).toBe(false);
        expect(files.has(readyPath)).toBe(false);
        expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
        expect(state.baseSnapshot).toEqual([]);
        expect(state.abandonMutationIntent).toHaveBeenCalledTimes(1);
      }
      expect(state.mutationLedger).toEqual([]);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
      Platform.isAndroidApp = previousAndroid;
    }
  });

  it("streams large mobile downloads through a temp file before rename", async () => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const hash = "aa".repeat(32);
    const size = 9 * 1024 * 1024;
    const downloadFile = vi.fn();
    const downloadFileToPath = vi.fn().mockResolvedValue({ size, hash });
    const rename = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter({
      appendBinary: vi.fn().mockResolvedValue(undefined),
      rename,
      stat: vi.fn(async (path: string) => path === "recording.m4a" ? { size, mtime: 1 } : null),
    });
    const mockState = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        downloadFileToPath,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "item-recording",
            name: "recording.m4a",
            size,
          eTag: "etag-recording",
          cTag: "ctag-recording",
          parentReference: {
            id: "files-root-id",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: hash } },
          }],
          "@odata.deltaLink": "tok",
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(1);
      expect(downloadFileToPath).toHaveBeenCalledWith(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        expect.any(Object),
        undefined,
        "item-recording",
        size,
        hash,
        undefined,
      );
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledWith(
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        "recording.m4a",
      );
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  });
});

describe("File download failure isolation", () => {
  it("continues later downloads when one content endpoint rejects the file", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const contentHash = await sha256Hex(content);
    const downloadFile = vi.fn()
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.Unauthorized,
        "content endpoint rejected file",
        401,
      ))
      .mockResolvedValueOnce(content);
    const files = new Map<string, ArrayBuffer>();
    const writeBinary = vi.fn(async (target: string, value: ArrayBuffer) => {
      files.set(target, value.slice(0));
    });
    const adapter = makeMockAdapter({
      writeBinary,
      exists: vi.fn().mockImplementation(async (target: string) =>
        files.has(target)),
      stat: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value ? { size: value.byteLength, mtime: 1 } : null;
      }),
      readBinary: vi.fn().mockImplementation(async (target: string) =>
        files.get(target)?.slice(0) ?? new ArrayBuffer(0)),
      rename: vi.fn().mockImplementation(async (
        source: string,
        target: string,
      ) => {
        const value = files.get(source);
        if (!value) throw new Error(`missing ${source}`);
        files.set(target, value);
        files.delete(source);
      }),
      remove: vi.fn().mockImplementation(async (target: string) => {
        files.delete(target);
      }),
    });
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime,
    });
    const remoteItems = ["first.md", "second.md"].map((name, index) => ({
      id: `item-${index}`,
      name,
      size: 3,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: "files-root-id",
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: contentHash } },
    }));

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({ value: remoteItems, "@odata.deltaLink": "tok" }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) => {
          const value = files.get(path);
          return value
            ? {
              path,
              size: value.byteLength,
              mtime: 1,
              hash: await sha256Hex(value),
              binary: false,
            }
            : null;
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const value = files.get(path);
          return value
            ? {
              status: "present",
              entry: {
                path,
                size: value.byteLength,
                mtime: 1,
                hash: await sha256Hex(value),
                binary: false,
              },
            }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.partial" ? `partial:${params?.errors}` : key,
      } as I18n,
    );

    const result = await executor.run("manual", {});

    expect(result.authExpired).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.message).toBe("partial:1");
    expect(result.downloaded).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(writeBinary).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/second.md.part.ready`,
      content,
    );
    expect(adapter.rename).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/second.md.part.ready`,
      "second.md",
    );
    expect(await sha256Hex(files.get("second.md")!)).toBe(contentHash);
    expect(setLastSyncTime).not.toHaveBeenCalled();
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: "first.md",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.contentUnavailable",
      })],
      new Set(["second.md"]),
    );
  });
});

describe("Download integrity gate", () => {
  async function runIntegrityCase(options: {
    remote: RemoteFileEntry;
    content: ArrayBuffer;
    getFileMetadata?: ReturnType<typeof vi.fn>;
    downloadFile?: OneDriveClient["downloadFile"];
  }) {
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([options.remote], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile ?? vi.fn().mockResolvedValue(options.content),
        getFileMetadata: options.getFileMetadata,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary, stat: vi.fn().mockResolvedValue({ size: options.content.byteLength, mtime: 2 }) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});
    return { result, state, writeBinary };
  }

  async function runStreamIntegrityCase(options: {
    remote: RemoteFileEntry;
    downloaded: { size: number; hash: string };
    tempContent: ArrayBuffer;
  }) {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const remove = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter({
      remove,
      rename,
      stat: vi.fn(async (path: string) => path.endsWith(".part")
        ? { size: options.tempContent.byteLength, mtime: 2 }
        : null),
      readBinary: vi.fn().mockResolvedValue(options.tempContent),
    });
    const state = makeActiveV2State([options.remote], []);
    const downloadFileToPath = vi.fn().mockResolvedValue(options.downloaded);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFileToPath }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});
      return { result, state, remove, rename, downloadFileToPath };
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  }

  it("rejects a truncated in-memory response before replacing the local file", async () => {
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 4,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
      },
      content: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
    expect(result.state.recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("rejects a 200 requestUrl fallback error body before replacing the local file", async () => {
    const errorBody = new TextEncoder().encode('{"error":"quota exceeded"}').buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: errorBody,
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const result = await runIntegrityCase({
        remote: {
          path: "note.bin",
          driveId: "note-id",
          downloadUrl: "https://download.example/note.bin",
          size: 1_024,
          mtime: 1,
          eTag: "etag-note",
          cTag: "ctag-note",
        },
        content: errorBody,
        downloadFile: client.downloadFile.bind(client),
      });

      expect(requestSpy).toHaveBeenCalled();
      expect(result.result.errors).toBe(1);
      expect(result.writeBinary).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
    }
  });

  it("rejects same-size bytes whose SHA-256 differs from Graph metadata", async () => {
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 3,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
        sha256Hash: "aa".repeat(32),
      },
      content: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
  });

  it("rechecks remote ID/eTag after a hashless download before writing", async () => {
    const getFileMetadata = vi.fn().mockResolvedValue({
      path: "note.bin",
      driveId: "note-id",
      size: 3,
      mtime: 2,
      eTag: "etag-changed",
    });
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 3,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
      },
      content: new Uint8Array([1, 2, 3]).buffer,
      getFileMetadata,
    });

    expect(getFileMetadata).toHaveBeenCalledWith(
      "testVault",
      "note.bin",
      "downloadVersionVerify",
    );
    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
    expect(result.state.reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: "note.bin",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.remoteChangedDuringDownload",
      })],
      new Set(),
    );
  });

  it("rejects a truncated streamed response and removes its temp file", async () => {
    const size = 9 * 1024 * 1024;
    const result = await runStreamIntegrityCase({
      remote: {
        path: "large.bin",
        driveId: "large-id",
        size,
        mtime: 1,
        eTag: "etag-large",
        cTag: "ctag-large",
        sha256Hash: "aa".repeat(32),
      },
      downloaded: { size: size - 1, hash: "aa".repeat(32) },
      tempContent: new ArrayBuffer(0),
    });

    expect(result.result.errors).toBe(1);
    expect(result.rename).not.toHaveBeenCalled();
    expect(result.remove).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/large.bin.part`,
    );
    expect(result.state.recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("rejects a same-size streamed temp file corrupted after download", async () => {
    const expectedBytes = new Uint8Array(9 * 1024 * 1024);
    const expectedHash = await sha256Hex(expectedBytes.buffer);
    const corruptedBytes = expectedBytes.slice();
    corruptedBytes[corruptedBytes.length - 1] = 1;
    const result = await runStreamIntegrityCase({
      remote: {
        path: "large.bin",
        driveId: "large-id",
        size: expectedBytes.byteLength,
        mtime: 1,
        eTag: "etag-large",
        cTag: "ctag-large",
        sha256Hash: expectedHash,
      },
      downloaded: { size: expectedBytes.byteLength, hash: expectedHash },
      tempContent: corruptedBytes.buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.rename).not.toHaveBeenCalled();
    expect(result.remove).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/large.bin.part`,
    );
  });
});

describe("Cloud baseline read-only compatibility", () => {
  function makeBaselineExecutor() {
    const uploadBaseline = vi.fn().mockResolvedValue(undefined);
    const markCloudBaselineSynced = vi.fn().mockResolvedValue(undefined);
    const baseEntry: BaseFileEntry = {
      path: "note.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-note",
    };
    const remoteEntry: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 10,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: baseEntry.hash,
    };
    const mockState = makeActiveV2State([remoteEntry], [baseEntry], {
      // Deliberately expose the removed legacy contract: a future accidental
      // reintroduction of the writer would make this production entry fail.
      needsCloudBaselineUpload: true,
      markCloudBaselineSynced,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadBaseline,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "item-note",
            name: "note.md",
            size: 10,
            eTag: "etag-note",
            cTag: "ctag-note",
            parentReference: {
              id: "files-root-id",
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: baseEntry.hash } },
          }],
          "@odata.deltaLink": "tok",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: "note.md",
            size: 10,
            mtime: 1,
            hash: baseEntry.hash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );
    return { executor, uploadBaseline, markCloudBaselineSynced };
  }

  it("never uploads the legacy baseline from a healthy production sync", async () => {
    const { executor, uploadBaseline, markCloudBaselineSynced } = makeBaselineExecutor();

    await executor.run("manual", {});

    expect(uploadBaseline).not.toHaveBeenCalled();
    expect(markCloudBaselineSynced).not.toHaveBeenCalled();
  });
});

describe("Persistent remote delta state", () => {
  async function makeMemoryState(
    initialData: Record<string, unknown> = {},
    initialRemoteState: Record<string, unknown> | null = null,
  ) {
    let persisted: Record<string, unknown> = structuredClone(initialData);
    let remoteStateJson: string | null = initialRemoteState
      ? JSON.stringify(initialRemoteState)
      : null;
    let saveQueue: Promise<void> = Promise.resolve();
    const plugin = {
      loadData: vi.fn(async () => persisted),
      saveData: vi.fn(async (next: Record<string, unknown>) => {
        persisted = structuredClone(next);
      }),
      updatePluginData: vi.fn(async (mutator: (data: Record<string, unknown>) => void) => {
        const task = saveQueue.then(async () => {
          const d = (await plugin.loadData()) ?? {};
          mutator(d);
          await plugin.saveData(d);
        });
        saveQueue = task.catch(() => undefined);
        return task;
      }),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn(async () => {
              if (remoteStateJson === null) throw new Error("missing");
              return remoteStateJson;
            }),
            write: vi.fn(async (_path: string, json: string) => {
              remoteStateJson = json;
            }),
          },
        },
      },
    };
    const state = new StateManager(plugin);
    await state.load();
    return state;
  }

  it("binds pending decision tokens through the indexed base lookup", async () => {
    const state = await makeMemoryState({
      "easy-sync-base-snapshot": {
        "conflict.md": {
          path: "conflict.md",
          hash: "bb".repeat(32),
          size: 10,
          eTag: "base-etag",
        },
      },
    }, {
      version: 1,
      generation: 0,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      deltaLink: null,
      entries: {},
      folders: {},
      folderIndexComplete: true,
    });
    await state.bindAccount("account-id");
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const plan: SyncPlan = {
      items: [{
        type: SyncActionType.Conflict,
        path: "conflict.md",
        local: {
          path: "conflict.md",
          size: 10,
          mtime: 1,
          hash: "cc".repeat(32),
          binary: false,
        },
        remote: {
          path: "conflict.md",
          driveId: "remote-id",
          size: 10,
          mtime: 1,
          eTag: "remote-etag",
          cTag: "remote-ctag",
        },
      }],
      lastTotalFiles: 1,
      confirmed: false,
    };
    const baseSnapshotMaterialization = vi.spyOn(state, "baseSnapshot", "get")
      .mockImplementation(() => {
        throw new Error("decision-token binding must not materialize the whole base snapshot");
      });

    try {
      (executor as unknown as {
        bindPendingDecisionTokens(plan: SyncPlan): void;
      }).bindPendingDecisionTokens(plan);
    } finally {
      baseSnapshotMaterialization.mockRestore();
    }

    expect(plan.items[0].decisionToken?.ancestorHash).toBe("bb".repeat(32));
  });

  function driveItem(
    path: string,
    hash: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `item-${path}`,
      name: path.split("/").pop()!,
      size: 3,
      eTag: `etag-${path}`,
      cTag: `ctag-${path}`,
      parentReference: {
        id: "files-root-id",
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: hash } },
      ...overrides,
    };
  }

  function emptyScanner(): LocalScanner {
    return {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
      scanFile: vi.fn().mockResolvedValue(null),
    } as unknown as LocalScanner;
  }

  async function makeManualResolutionHarness(input: {
    local?: Record<string, string>;
    remote?: Record<string, string>;
    sourcePath?: string;
    path: string;
    configDir?: string;
    receiptedRenameAnchorCollision?: boolean;
  }) {
    const encoder = new TextEncoder();
    const localBytes = new Map<string, ArrayBuffer>();
    for (const [path, value] of Object.entries(input.local ?? {})) {
      localBytes.set(path, encoder.encode(value).buffer);
    }
    let version = 1;
    const remoteFoldersByPath = new Map<string, RemoteFolderEntry>();
    const ensureRemoteFolder = (path: string): string => {
      if (!path) return TEST_SYNC_SCOPE.filesRootId;
      const existing = remoteFoldersByPath.get(path);
      if (existing) return existing.driveId;
      const separator = path.lastIndexOf("/");
      const parent = separator < 0 ? "" : path.slice(0, separator);
      const entry: RemoteFolderEntry = {
        path,
        driveId: `folder-${path}`,
        parentId: ensureRemoteFolder(parent),
        name: separator < 0 ? path : path.slice(separator + 1),
      };
      remoteFoldersByPath.set(path, entry);
      return entry.driveId;
    };
    const remoteFiles = new Map<string, {
      entry: RemoteFileEntry;
      bytes: ArrayBuffer;
    }>();
    for (const [path, value] of Object.entries(input.remote ?? {})) {
      const bytes = encoder.encode(value).buffer;
      const separator = path.lastIndexOf("/");
      const parentPath = separator < 0 ? "" : path.slice(0, separator);
      remoteFiles.set(path, {
        entry: {
          path,
          driveId: `remote-${path}`,
          parentId: ensureRemoteFolder(parentPath),
          size: bytes.byteLength,
          mtime: 1,
          eTag: `etag-${version++}`,
          cTag: `ctag-${version}`,
          sha256Hash: await sha256Hex(bytes),
        },
        bytes,
      });
    }
    const inspectLocal = vi.fn(async (path: string) => {
      const bytes = localBytes.get(path);
      return bytes
        ? {
            status: "present" as const,
            entry: {
              path,
              hash: await sha256Hex(bytes),
              size: bytes.byteLength,
              mtime: 1,
              binary: false,
            },
          }
        : { status: "missing" as const };
    });
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => localBytes.has(path)),
      stat: vi.fn(async (path: string) => {
        const bytes = localBytes.get(path);
        return bytes ? { type: "file", size: bytes.byteLength, mtime: 1, ctime: 1 } : null;
      }),
      readBinary: vi.fn(async (path: string) => {
        const bytes = localBytes.get(path);
        if (!bytes) throw new Error(`missing local: ${path}`);
        return bytes.slice(0);
      }),
      writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        localBytes.set(path, bytes.slice(0));
      }),
      remove: vi.fn(async (path: string) => {
        localBytes.delete(path);
      }),
      rename: vi.fn(async (source: string, target: string) => {
        const bytes = localBytes.get(source);
        if (!bytes) throw new Error(`missing local: ${source}`);
        localBytes.set(target, bytes);
        localBytes.delete(source);
      }),
    });
    const metadata = (path: string) => {
      const current = remoteFiles.get(path);
      return current ? {
        eTag: current.entry.eTag,
        cTag: current.entry.cTag,
        size: current.entry.size,
        sha256Hash: current.entry.sha256Hash,
        driveId: current.entry.driveId,
        parentId: current.entry.parentId,
        mtime: current.entry.mtime,
      } : null;
    };
    const uploadFile = vi.fn(async (
      _vault: string,
      path: string,
      bytes: ArrayBuffer,
    ) => {
      const previous = remoteFiles.get(path)?.entry;
      const entry: RemoteFileEntry = {
        path,
        driveId: previous?.driveId ?? `uploaded-${path}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: bytes.byteLength,
        mtime: version,
        eTag: `etag-${version++}`,
        cTag: `ctag-${version}`,
        sha256Hash: await sha256Hex(bytes),
      };
      remoteFiles.set(path, { entry, bytes: bytes.slice(0) });
      return {
        id: entry.driveId,
        eTag: entry.eTag,
        cTag: entry.cTag,
        size: entry.size,
        parentReference: { id: entry.parentId },
      };
    });
    const deleteItem = vi.fn(async (
      _vault: string,
      path: string,
      eTag?: string,
      driveId?: string,
    ) => {
      const current = remoteFiles.get(path);
      if (!current || current.entry.eTag !== eTag || current.entry.driveId !== driveId) {
        throw new Error(`remote delete precondition changed: ${path}`);
      }
      remoteFiles.delete(path);
    });
    const moveItemById = vi.fn(async (
      driveId: string,
      eTag: string,
      newName: string,
      parentId: string,
    ) => {
      const source = [...remoteFiles.entries()].find(
        ([, current]) => current.entry.driveId === driveId,
      );
      if (!source || source[1].entry.eTag !== eTag) throw new Error("move precondition changed");
      const [sourcePath, current] = source;
      const targetPath = newName;
      const nextEntry = {
        ...current.entry,
        path: targetPath,
        parentId,
        eTag: `etag-${version++}`,
      };
      remoteFiles.delete(sourcePath);
      remoteFiles.set(targetPath, { entry: nextEntry, bytes: current.bytes });
      return {
        id: driveId,
        name: newName,
        size: nextEntry.size,
        eTag: nextEntry.eTag,
        cTag: nextEntry.cTag,
        parentReference: { id: parentId },
        file: { hashes: { sha256Hash: nextEntry.sha256Hash } },
      };
    });
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const committedRemoteEntries = [...remoteFiles.values()].map((item) => item.entry);
    const committedBaseEntries: BaseFileEntry[] = [];
    let blockedIntent: MutationIntentV1 = {
      version: 1,
      operationId: "blocked-operation",
      planRevision: 1,
      scope,
      action: input.sourcePath ? "renameRemote" : "upload",
      path: input.path,
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      expectedLocal: { exists: false },
      expectedRemote: { exists: false },
      createdAt: 1,
    };
    let blockedReceipt: MutationReceiptV1 | null = null;
    if (input.receiptedRenameAnchorCollision) {
      if (!input.sourcePath) throw new Error("collision harness requires a source path");
      const targetBytes = localBytes.get(input.path);
      if (!targetBytes) throw new Error("collision harness requires the local target");
      const hash = await sha256Hex(targetBytes);
      const sourceSeparator = input.sourcePath.lastIndexOf("/");
      const sourceParentPath = sourceSeparator < 0 ? "" : input.sourcePath.slice(0, sourceSeparator);
      const targetSeparator = input.path.lastIndexOf("/");
      const targetParentPath = targetSeparator < 0 ? "" : input.path.slice(0, targetSeparator);
      const staleSource: RemoteFileEntry = {
        path: input.sourcePath,
        driveId: `stale-source-${input.sourcePath}`,
        parentId: ensureRemoteFolder(sourceParentPath),
        size: targetBytes.byteLength,
        mtime: 1,
        eTag: "etag-stale-source",
        cTag: "ctag-stale-source",
        sha256Hash: hash,
      };
      const moved: RemoteFileEntry = {
        ...staleSource,
        path: input.path,
        parentId: ensureRemoteFolder(targetParentPath),
        eTag: "etag-receipted-move",
      };
      committedRemoteEntries.splice(0, committedRemoteEntries.length, staleSource);
      committedBaseEntries.push(
        {
          path: input.sourcePath,
          hash,
          size: targetBytes.byteLength,
          eTag: staleSource.eTag,
        },
        {
          path: input.path,
          hash: "f".repeat(64),
          size: 1,
          eTag: "etag-stale-target",
        },
      );
      blockedIntent = {
        ...blockedIntent,
        action: "renameRemote",
        sourcePath: input.sourcePath,
        expectedLocal: { exists: true, hash, size: targetBytes.byteLength },
        expectedRemote: {
          exists: true,
          driveId: staleSource.driveId,
          eTag: staleSource.eTag,
          size: staleSource.size,
          sha256Hash: hash,
        },
      };
      blockedReceipt = {
        version: 1,
        operationId: blockedIntent.operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: input.path,
            hash,
            size: targetBytes.byteLength,
            eTag: moved.eTag,
          }],
          baseRemovals: [input.sourcePath],
          remoteUpserts: [moved],
          remoteDeletes: [input.sourcePath],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      };
    }
    const ledger: MutationLedgerEntryV1[] = [{
      intent: blockedIntent,
      receipt: blockedReceipt,
    }];
    const state = makeActiveV2State(committedRemoteEntries, committedBaseEntries, {
      mutationLedger: ledger,
      remoteFolders: [...remoteFoldersByPath.values()],
    });
    const getDriveItemMetadataById = vi.fn(async (driveId: string) => {
      const found = [...remoteFiles.values()].find(
        (current) => current.entry.driveId === driveId,
      );
      return found ? { id: driveId, eTag: found.entry.eTag } : null;
    });
    const onedrive = makeMockOneDrive({
      uploadFile,
      deleteItem,
      moveItemById,
      getFileMetadata: vi.fn(async (_vault: string, path: string) => metadata(path)),
      getDriveItemMetadataById,
      downloadFile: vi.fn(async (_vault: string, path: string) => {
        const current = remoteFiles.get(path);
        if (!current) throw new Error(`missing remote: ${path}`);
        return current.bytes.slice(0);
      }),
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: input.configDir ?? ".obsidian",
          adapter,
          getAbstractFileByPath: vi.fn((path: string) =>
            localBytes.has(path) ? new TFile(path) : null),
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          rename: vi.fn(async (file: TFile, target: string) => {
            await adapter.rename(file.path, target);
          }),
        },
        inspectFile: inspectLocal,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    return {
      adapter,
      deleteItem,
      executor,
      getDriveItemMetadataById,
      inspectLocal,
      localBytes,
      moveItemById,
      remoteFiles,
      state,
      uploadFile,
    };
  }

  it("resolves a facts-changed record by keeping the exact current local file", async () => {
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local" },
      remote: { "note.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    );

    expect(reviewed).toMatchObject({
      path: "note.md",
      identical: false,
      keepLocal: { available: true, deletesOtherSide: false },
      keepRemote: { available: true, deletesOtherSide: false },
    });
    expect(harness.uploadFile).not.toHaveBeenCalled();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(harness.remoteFiles.get("note.md")!.bytes))
      .toBe("local");
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: "note.md",
        hash: await sha256Hex(new TextEncoder().encode("local").buffer),
      }),
    ]);
  });

  it("resolves a facts-changed record by keeping the exact current cloud file", async () => {
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local" },
      remote: { "note.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(harness.localBytes.get("note.md")!)).toBe("cloud");
  });

  it("supports both explicit deletion directions without guessing from absence", async () => {
    const deleteRemote = await makeManualResolutionHarness({
      path: "remote-only.md",
      remote: { "remote-only.md": "cloud" },
    });
    const remoteReview = await deleteRemote.executor
      .getMutationRecoveryResolutionSnapshot();
    expect(remoteReview?.keepLocal).toEqual({
      available: true,
      deletesOtherSide: true,
    });
    expect(await deleteRemote.executor.resolveMutationRecovery(
      remoteReview!,
      "keep-local",
    )).toBe(true);
    expect(deleteRemote.remoteFiles.has("remote-only.md")).toBe(false);
    expect(deleteRemote.deleteItem).toHaveBeenCalledOnce();

    const deleteLocal = await makeManualResolutionHarness({
      path: "local-only.md",
      local: { "local-only.md": "local" },
    });
    const localReview = await deleteLocal.executor
      .getMutationRecoveryResolutionSnapshot();
    expect(localReview?.keepRemote).toEqual({
      available: true,
      deletesOtherSide: true,
    });
    expect(await deleteLocal.executor.resolveMutationRecovery(
      localReview!,
      "keep-remote",
    )).toBe(true);
    expect(deleteLocal.localBytes.has("local-only.md")).toBe(false);
    expect(deleteLocal.adapter.remove).toHaveBeenCalledWith("local-only.md");
  });

  it("turns strict identical facts into a state-only checkpoint", async () => {
    const harness = await makeManualResolutionHarness({
      path: "same.md",
      local: { "same.md": "same" },
      remote: { "same.md": "same" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed?.identical).toBe(true);
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("performs zero writes when facts change after the user review", async () => {
    const harness = await makeManualResolutionHarness({
      path: "changed.md",
      local: { "changed.md": "local" },
      remote: { "changed.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.localBytes.set(
      "changed.md",
      new TextEncoder().encode("newer local").buffer,
    );

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.attachManualMutationResolution).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);

    const remoteChanged = await makeManualResolutionHarness({
      path: "remote-changed.md",
      local: { "remote-changed.md": "local" },
      remote: { "remote-changed.md": "cloud" },
    });
    const remoteReview = await remoteChanged.executor
      .getMutationRecoveryResolutionSnapshot();
    const current = remoteChanged.remoteFiles.get("remote-changed.md")!;
    remoteChanged.remoteFiles.set("remote-changed.md", {
      entry: { ...current.entry, eTag: "etag-newer" },
      bytes: new TextEncoder().encode("newer cloud").buffer,
    });
    expect(await remoteChanged.executor.resolveMutationRecovery(
      remoteReview!,
      "keep-local",
    )).toBe(false);
    expect(remoteChanged.uploadFile).not.toHaveBeenCalled();
    expect(remoteChanged.state.attachManualMutationResolution)
      .not.toHaveBeenCalled();
  });

  it("does not bypass managed-config or community-plugin ownership boundaries", async () => {
    const managedConfig = await makeManualResolutionHarness({
      path: ".obsidian/app.json",
      local: { ".obsidian/app.json": "{}" },
      remote: { ".obsidian/app.json": "{\"x\":1}" },
    });
    expect(await managedConfig.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();

    const pluginFile = await makeManualResolutionHarness({
      path: ".obsidian/plugins/example/main.js",
      local: { ".obsidian/plugins/example/main.js": "local" },
      remote: { ".obsidian/plugins/example/main.js": "cloud" },
    });
    expect(await pluginFile.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();
    expect(pluginFile.uploadFile).not.toHaveBeenCalled();

    for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
      const path = `.obsidian/plugins/easy-sync/${fileName}`;
      const selfSyncFile = await makeManualResolutionHarness({
        path,
        local: { [path]: "local" },
        remote: { [path]: "cloud" },
      });
      expect(await selfSyncFile.executor.getMutationRecoveryResolutionSnapshot())
        .toBeNull();
      expect(selfSyncFile.uploadFile).not.toHaveBeenCalled();
    }

    const customConfig = await makeManualResolutionHarness({
      configDir: ".config",
      path: ".config/app.json",
      local: { ".config/app.json": "{}" },
      remote: { ".config/app.json": "{\"x\":1}" },
    });
    expect(await customConfig.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();
    expect(customConfig.uploadFile).not.toHaveBeenCalled();
  });

  it("cancels after the final reviewed inspection without starting a write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "cancel-before-write.md",
      local: { "cancel-before-write.md": "local" },
      remote: { "cancel-before-write.md": "cloud" },
    });
    const currentRemote = harness.remoteFiles.get("cancel-before-write.md")!.entry;
    const localBytes = harness.localBytes.get("cancel-before-write.md")!;
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "manual-cancel-before-write",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "upload",
      path: "cancel-before-write.md",
      expectedLocal: {
        exists: true,
        hash: await sha256Hex(localBytes),
        size: localBytes.byteLength,
      },
      expectedRemote: {
        exists: true,
        driveId: currentRemote.driveId,
        eTag: currentRemote.eTag,
        size: currentRemote.size,
        sha256Hash: currentRemote.sha256Hash,
      },
      createdAt: 1,
    };
    const inspect = harness.inspectLocal.getMockImplementation()!;
    harness.inspectLocal.mockImplementationOnce(async (path: string) => {
      const current = await inspect(path);
      harness.executor.cancel();
      return current;
    });
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();

    await expect((harness.executor as unknown as {
      executeManualMutationIntentWithCanonicalExecutor(
        intent: MutationIntentV1,
        operationEpoch: number,
      ): Promise<MutationCheckpointV1>;
    }).executeManualMutationIntentWithCanonicalExecutor(intent, epoch))
      .rejects.toThrow("cancelled");
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
  });

  it("resolves a pure move in either direction and rejects composite moves", async () => {
    const keepLocal = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "new.md": "same" },
      remote: { "old.md": "same" },
    });
    const localReview = await keepLocal.executor.getMutationRecoveryResolutionSnapshot();
    expect(localReview?.keepLocal.available).toBe(true);
    expect(await keepLocal.executor.resolveMutationRecovery(localReview!, "keep-local"))
      .toBe(true);
    expect(keepLocal.remoteFiles.has("old.md")).toBe(false);
    expect(keepLocal.remoteFiles.has("new.md")).toBe(true);
    expect(keepLocal.moveItemById).toHaveBeenCalledOnce();

    const keepRemote = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "old.md": "same" },
      remote: { "new.md": "same" },
    });
    const remoteReview = await keepRemote.executor.getMutationRecoveryResolutionSnapshot();
    expect(remoteReview?.keepRemote.available).toBe(true);
    expect(await keepRemote.executor.resolveMutationRecovery(remoteReview!, "keep-remote"))
      .toBe(true);
    expect(keepRemote.localBytes.has("old.md")).toBe(false);
    expect(keepRemote.localBytes.has("new.md")).toBe(true);

    const composite = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "new.md": "local" },
      remote: { "old.md": "cloud" },
    });
    const compositeReview = await composite.executor
      .getMutationRecoveryResolutionSnapshot();
    expect(compositeReview?.keepLocal.available).toBe(false);
    expect(compositeReview?.keepRemote.available).toBe(false);
  });

  it("recovers a receipted rename target-anchor collision by creating the reviewed local target", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    expect(reviewed).toMatchObject({
      previousAction: "renameRemote",
      sourcePath: "old.xmind",
      path: "new.xmind",
      keepLocal: { available: true, deletesOtherSide: false },
      keepRemote: { available: false, deletesOtherSide: false },
      recoveryEvidence: {
        kind: "receipted-rename-target-anchor-collision",
      },
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.moveItemById).not.toHaveBeenCalled();
    expect(harness.remoteFiles.has("old.xmind")).toBe(false);
    expect(harness.remoteFiles.get("new.xmind")?.entry.driveId).toBe("uploaded-new.xmind");
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("blocks a future remote rename before Graph when the target already owns another anchor", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const committedSource = harness.state.remoteSnapshot[0];
    const bytes = harness.localBytes.get("new.xmind")!;
    harness.remoteFiles.set("old.xmind", {
      entry: committedSource,
      bytes: bytes.slice(0),
    });
    const localHash = await sha256Hex(bytes);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "preflight-collision",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "renameRemote",
      path: "new.xmind",
      sourcePath: "old.xmind",
      expectedLocal: { exists: true, hash: localHash, size: bytes.byteLength },
      expectedRemote: {
        exists: true,
        driveId: committedSource.driveId,
        eTag: committedSource.eTag,
        size: committedSource.size,
        sha256Hash: committedSource.sha256Hash,
      },
      createdAt: 3,
    };
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();

    await expect((harness.executor as unknown as {
      executeManualMutationIntentWithCanonicalExecutor(
        intent: MutationIntentV1,
        operationEpoch: number,
      ): Promise<MutationCheckpointV1>;
    }).executeManualMutationIntentWithCanonicalExecutor(intent, epoch))
      .rejects.toThrow("target is owned by another V2 anchor");
    expect(harness.moveItemById).not.toHaveBeenCalled();
    expect(harness.remoteFiles.has("old.xmind")).toBe(true);
    expect(harness.remoteFiles.has("new.xmind")).toBe(false);
  });

  it("does zero writes when a stale remote identity reappears after reviewing the collision", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const staleId = reviewed?.recoveryEvidence?.staleRemoteIds[0];
    expect(staleId).toBeTruthy();
    const bytes = new TextEncoder().encode("reappeared").buffer;
    harness.remoteFiles.set("elsewhere.xmind", {
      entry: {
        path: "elsewhere.xmind",
        driveId: staleId!,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: bytes.byteLength,
        mtime: 3,
        eTag: "etag-reappeared",
        cTag: "ctag-reappeared",
        sha256Hash: await sha256Hex(bytes),
      },
      bytes,
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("keeps the receipted collision blocked when a stale identity reappears after upload", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const staleId = reviewed!.recoveryEvidence!.staleRemoteIds[0];
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      const result = await upload(...args);
      const bytes = new TextEncoder().encode("reappeared-after-upload").buffer;
      harness.remoteFiles.set("elsewhere.xmind", {
        entry: {
          path: "elsewhere.xmind",
          driveId: staleId,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: bytes.byteLength,
          mtime: 4,
          eTag: "etag-reappeared-after-upload",
          cTag: "ctag-reappeared-after-upload",
          sha256Hash: await sha256Hex(bytes),
        },
        bytes,
      });
      return result;
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: expect.objectContaining({ version: 1 }) });
    expect(harness.state.commitManualMutationResolutionCheckpoint)
      .not.toHaveBeenCalled();
  });

  it("recovers a lost upload response for the collision without repeating the write", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      await upload(...args);
      throw new Error("upload response lost");
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("replays only the collision checkpoint after V2 publication survives ledger cleanup failure", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const commit = vi.mocked(harness.state.commitManualMutationResolutionCheckpoint)
      .getMockImplementation()!;
    vi.mocked(harness.state.commitManualMutationResolutionCheckpoint)
      .mockImplementationOnce(async (sourceOperationId: string) => {
        const retained = structuredClone(harness.state.mutationLedger[0]);
        await commit(sourceOperationId);
        (harness.state.mutationLedger as MutationLedgerEntryV1[]).push(retained);
        throw new Error("ledger cleanup interrupted");
      });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("recovers an upload response loss without repeating the remote write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "response-lost.md",
      local: { "response-lost.md": "local" },
      remote: { "response-lost.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      await upload(...args);
      throw new Error("upload response lost");
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(new TextDecoder().decode(harness.remoteFiles.get("response-lost.md")!.bytes))
      .toBe("local");
  });

  it("replays only the receipt after a crash window following the remote write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "receipt-crash.md",
      local: { "receipt-crash.md": "local" },
      remote: { "receipt-crash.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    vi.mocked(harness.state.recordManualMutationResolutionReceipt)
      .mockRejectedValueOnce(new Error("receipt persistence interrupted"));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: null });

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("keeps a receipt and defers the checkpoint when cancellation lands after the write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "cancelled.md",
      local: { "cancelled.md": "local" },
      remote: { "cancelled.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      const result = await upload(...args);
      harness.executor.cancel();
      return result;
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: expect.objectContaining({ version: 1 }) });
    expect(harness.state.commitManualMutationResolutionCheckpoint)
      .not.toHaveBeenCalled();

    (harness.executor as unknown as { cancelled: boolean }).cancelled = false;
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("retains the reviewed continuation when a network failure proves no write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "offline.md",
      local: { "offline.md": "local" },
      remote: { "offline.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({
        choice: "keep-local",
        externalMutation: true,
        receipt: null,
      });
    expect(new TextDecoder().decode(harness.remoteFiles.get("offline.md")!.bytes))
      .toBe("cloud");
  });

  it("keeps a reviewed overwrite blocked after a 412 instead of applying stale facts", async () => {
    const harness = await makeManualResolutionHarness({
      path: "raced.md",
      local: { "raced.md": "local" },
      remote: { "raced.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.PreconditionFailed,
      "etag changed",
      412,
    ));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: null });
    expect(new TextDecoder().decode(harness.remoteFiles.get("raced.md")!.bytes))
      .toBe("cloud");
  });

  it("resumes a durable reviewed continuation after the interrupted side action", async () => {
    const harness = await makeManualResolutionHarness({
      path: "resume.md",
      local: { "resume.md": "local" },
      remote: { "resume.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    const summary = await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(summary).toMatchObject({
      state: "settled",
      total: 1,
      settled: 1,
      remaining: 0,
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(2);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("blocks planning when an unresolved mutation intent contradicts current remote identity", async () => {
    const expectedHash = "aa".repeat(32);
    const currentHash = "bb".repeat(32);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-unresolved",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash: expectedHash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const local: LocalFileEntry = {
      path: "note.md",
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({ id: "new-id", eTag: "new-etag" });
    const scanAll = vi.fn().mockResolvedValue({
      entries: [local],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          path: "note.md",
          driveId: "unexpected-id",
          size: 3,
          mtime: 1,
          eTag: "unexpected-etag",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.syncFailed"
            ? `failed:${params?.message}`
            : key,
      } as I18n,
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "failed:Mutation outcome requires manual review: op-unresolved",
    );
    expect(scanAll).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toEqual({
      state: "blocked",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: null,
      blockReason: "facts-changed",
      blockedOperationId: "op-unresolved",
    });
  });

  it("settles an active V2 ledger in recovery-only mode without entering planning or healthy commit", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "recovery-only.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-recovery-only-not-applied",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const scanAll = vi.fn().mockResolvedValue({
      entries: [local],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const uploadFile = vi.fn();
    const initVaultScope = vi.fn().mockResolvedValue({
      driveId: activeScope.driveId,
      vaultFolderId: activeScope.vaultFolderId,
      filesRootId: activeScope.filesRootId,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        initVaultScope,
        uploadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const executePlan = vi.spyOn(
      executor as unknown as { executePlan: (...args: unknown[]) => Promise<void> },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(true);
    expect(result.mutationRecovery).toEqual({
      state: "settled",
      total: 1,
      settled: 1,
      remaining: 0,
      retryAfterSeconds: null,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(initVaultScope).toHaveBeenCalledWith(
      "testVault",
      { createMissing: false },
    );
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("rejects recovery-only mode before scan and Graph when public precommit is still authoritative", async () => {
    const scanAll = vi.fn();
    const initVaultScope = vi.fn();
    const state = {
      ...remoteStateStub(),
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
      hasV2StateLoadRecoveryBlock: false,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ initVaultScope }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.v2RecoveryBlocked");
    expect(scanAll).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
  });

  it("classifies an exhausted recovery read Retry-After without entering planning or mutation", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "retry-after.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-retry-after",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockRejectedValue(new OneDriveError(
          OneDriveErrorType.RateLimited,
          "recovery observation rate limited",
          429,
          12,
        )),
        uploadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const executePlan = vi.spyOn(
      executor as unknown as { executePlan: (...args: unknown[]) => Promise<void> },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.mutationRecovery).toEqual({
      state: "network-unavailable",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: 12,
    });
    expect(state.mutationLedger).toHaveLength(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("does not classify a cancelled recovery observation as a retryable network failure", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "cancelled-recovery.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-cancelled-recovery",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    let executor!: SyncExecutor;
    const getFileMetadata = vi.fn().mockImplementation(async () => {
      executor.cancel();
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        "aborted recovery observation",
      );
    });
    executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const executePlan = vi.spyOn(
      executor as unknown as {
        executePlan: (...args: unknown[]) => Promise<void>;
      },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(result.errors).toBe(0);
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toHaveLength(1);
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("independently settles later public 1.1.3 intents while the first unresolved upload still blocks planning", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope);
    const first = localEntries[0];
    const applied = new Set(localEntries.slice(1, 12).map((entry) => entry.path));
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const localByPath = new Map(
      localEntries.map((entry) => [entry.path, entry]),
    );
    const uploadFile = vi.fn().mockResolvedValue({
      id: "must-not-upload",
      eTag: "must-not-upload",
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vaultName: string, path: string) => {
        const local = localByPath.get(path);
        if (!local) return null;
        if (path === first.path) {
          return {
            path,
            driveId: "unrelated-remote-id",
            parentId: TEST_SYNC_SCOPE.filesRootId,
            size: local.size,
            mtime: 1,
            eTag: "unrelated-etag",
            sha256Hash: "ff".repeat(32),
          };
        }
        if (!applied.has(path)) return null;
        return {
          path,
          driveId: `applied-${path}`,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: local.size,
          mtime: 2,
          eTag: `etag-${path}`,
          sha256Hash: local.hash,
        };
      },
    );
    const scanAll = vi.fn().mockResolvedValue({
      entries: localEntries,
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const recoveryWarn = vi.fn();
    const diagnostics = {
      isEnabled: vi.fn((category: string) => category !== "onedrive"),
      log: vi.fn(),
      warn: recoveryWarn,
      error: vi.fn(),
    } as unknown as DiagnosticLogger;
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(
              new Uint8Array([1, 2, 3]).buffer,
            ),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localByPath.get(path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.syncFailed"
            ? `failed:${params?.message}`
            : key,
      } as I18n,
      undefined,
      diagnostics,
    );

    const result = await executor.run("manual", {});

    expect(PUBLIC_113_NETWORK_RECOVERY_INCIDENT).toEqual({
      singleIntentCount: 1,
      batchIntentCount: 23,
      requestFailure: {
        type: "NetworkError",
        statusCode: 0,
        graphCode: null,
      },
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "failed:Mutation outcome requires manual review: sanitized-network-op-1",
    );
    expect(scanAll).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.mutationLedger.map(
      (record) => record.intent.operationId,
    )).toEqual(["sanitized-network-op-1"]);
    expect(state.recordMutationReceipt).toHaveBeenCalledTimes(11);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(11);
    expect(state.abandonMutationIntent).toHaveBeenCalledTimes(11);
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        schemaVersion: 1,
        total: 23,
        settled: 22,
        remaining: 1,
        applied: 11,
        notApplied: 11,
        blocked: 1,
        firstBlockedOperationId: "sanitized-network-op-1",
        externalMutations: 0,
      }),
    );
  });

  it("keeps a status-0 observation pending without hiding later provable ledger outcomes", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope, 3);
    const localByPath = new Map(
      localEntries.map((entry) => [entry.path, entry]),
    );
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vaultName: string, path: string) => {
        if (path === localEntries[0].path) {
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            "offline during recovery observation",
            PUBLIC_113_NETWORK_RECOVERY_INCIDENT.requestFailure.statusCode,
            null,
            PUBLIC_113_NETWORK_RECOVERY_INCIDENT.requestFailure.graphCode,
          );
        }
        if (path === localEntries[2].path) return null;
        const local = localByPath.get(path)!;
        return {
          path,
          driveId: `applied-${path}`,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: local.size,
          mtime: 2,
          eTag: `etag-${path}`,
          sha256Hash: local.hash,
        };
      },
    );
    const recoveryWarn = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localByPath.get(path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        isEnabled: vi.fn().mockReturnValue(false),
        log: vi.fn(),
        warn: recoveryWarn,
        error: vi.fn(),
      } as unknown as DiagnosticLogger,
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(activeScope)).rejects.toThrow(
      "offline during recovery observation",
    );

    expect(state.mutationLedger.map(
      (record) => record.intent.operationId,
    )).toEqual(["sanitized-network-op-1"]);
    expect(state.recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(state.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        total: 3,
        settled: 2,
        remaining: 1,
        blocked: 1,
        blockedByReason: { "observation-unavailable": 1 },
        externalMutations: 0,
      }),
    );
  });

  it("does not settle a later ledger record whose path depends on an unresolved operation", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope, 2);
    const first = localEntries[0];
    ledger[1] = {
      intent: {
        ...ledger[1].intent,
        path: first.path,
        expectedLocal: {
          exists: true,
          hash: first.hash,
          size: first.size,
        },
      },
      receipt: null,
    };
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const unrelatedRemote = {
      path: first.path,
      driveId: "unrelated-remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: first.size,
      mtime: 1,
      eTag: "unrelated-etag",
      sha256Hash: "ff".repeat(32),
    };
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce(unrelatedRemote)
      .mockResolvedValueOnce(unrelatedRemote)
      .mockResolvedValue(null);
    const recoveryWarn = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: first,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        isEnabled: vi.fn().mockReturnValue(false),
        log: vi.fn(),
        warn: recoveryWarn,
        error: vi.fn(),
      } as unknown as DiagnosticLogger,
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(activeScope)).rejects.toThrow(
      "Mutation outcome requires manual review: sanitized-network-op-1",
    );

    expect(getFileMetadata).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toHaveLength(2);
    expect(state.recordMutationReceipt).not.toHaveBeenCalled();
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.abandonMutationIntent).not.toHaveBeenCalled();
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        total: 2,
        settled: 0,
        remaining: 2,
        blocked: 2,
        blockedByReason: {
          "outcome-unresolved": 1,
          "dependent-on-unresolved": 1,
        },
        externalMutations: 0,
      }),
    );
  });

  it("does not treat a delete response as applied when only the old path is 404", async () => {
    const remote: RemoteFileEntry = {
      path: "moved-before-recovery.md",
      driveId: "delete-target",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-delete-target",
      cTag: "ctag-delete-target",
      sha256Hash: "aa".repeat(32),
    };
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-path-404-only",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "deleteRemote",
          path: "note.md",
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
            sha256Hash: remote.sha256Hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: remote.driveId,
          name: "moved-before-recovery.md",
          size: remote.size,
          eTag: remote.eTag,
          cTag: remote.cTag,
          file: { hashes: { sha256Hash: remote.sha256Hash } },
          parentReference: { id: "another-folder" },
        }),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(TEST_SYNC_SCOPE)).rejects.toThrow(
      "Mutation outcome requires manual review",
    );
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
  });

  it("does not consume a public remote-delete recovery before V2 cutover", async () => {
    const state = await makeMemoryState({
      "easy-sync-base-snapshot": {
        "note.md": {
          path: "note.md",
          hash: "aa".repeat(32),
          size: 3,
          eTag: "etag-delete-target",
        },
      },
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-exact-404",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "deleteRemote",
          path: "note.md",
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: "delete-target",
            eTag: "etag-delete-target",
            size: 3,
            sha256Hash: "aa".repeat(32),
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(TEST_SYNC_SCOPE))
      .rejects.toThrow("active V2 authority");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.baseSnapshot).toEqual([{
      path: "note.md",
      hash: "aa".repeat(32),
      size: 3,
      eTag: "etag-delete-target",
    }]);
  });

  it("does not publish a remote-delete receipt while the exact item still exists", async () => {
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-receipt-path-404-only",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "deleteRemote",
          path: "note.md",
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: "delete-target",
            eTag: "etag-delete-target",
            size: 3,
            sha256Hash: "aa".repeat(32),
          },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-delete-receipt-path-404-only",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [],
            baseRemovals: ["note.md"],
            remoteUpserts: [],
            remoteDeletes: ["note.md"],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: "delete-target",
          name: "moved-before-checkpoint.md",
          size: 3,
          eTag: "etag-delete-target",
          file: { hashes: { sha256Hash: "aa".repeat(32) } },
          parentReference: { id: "another-folder" },
        }),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(TEST_SYNC_SCOPE)).rejects.toThrow(
      "Mutation receipt no longer matches",
    );
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
  });

  it("recovers an applied unreceipted upload without uploading the file again", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "note.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-response-lost",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-upload-recovered",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("recovers an applied unreceipted upload by stable content readback when Graph omits SHA-256", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "note.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-response-lost-no-graph-hash",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-upload-readback-recovered",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        downloadFile,
        getFileMetadata,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      remote.downloadUrl,
      remote.driveId,
      remote.size,
    );
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(getFileMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("restores a missing local file from a version-matched upload receipt before checkpointing", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "restored.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-restored",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-restored",
      cTag: "ctag-restored",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-receipted-local-missing",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-upload-receipted-local-missing",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [{
              path: local.path,
              hash,
              size: local.size,
              eTag: remote.eTag,
            }],
            baseRemovals: [],
            remoteUpserts: [remote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const files = new Map<string, ArrayBuffer>();
    const adapter = makeMockAdapter({
      stat: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        return bytes ? { type: "file", size: bytes.byteLength, mtime: 4, ctime: 4 } : null;
      }),
      readBinary: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      }),
      writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        files.set(path, bytes);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, bytes);
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    });
    const scanAll = vi.fn(async () => ({
      entries: files.has(local.path) ? [local] : [],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-restored",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn(async () => files.has(local.path)
          ? { status: "present", entry: local }
          : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(files.get(local.path)).toEqual(content);
    expect(scanAll).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("abandons a proven not-applied upload intent before generating a new plan", async () => {
    const content = new Uint8Array([7, 8, 9]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "not-applied.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-never-applied",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: "new-upload-id",
      eTag: "new-upload-etag",
      cTag: "new-upload-ctag",
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-not-applied",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(undefined),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: "new-upload-etag",
    });
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: local.path,
      driveId: "new-upload-id",
      eTag: "new-upload-etag",
      cTag: "new-upload-ctag",
      sha256Hash: hash,
    }));
  });

  it("defers an upload when the file changes after scan without leaving a mutation intent", async () => {
    const scannedContent = new Uint8Array([1, 2, 3]).buffer;
    const currentContent = new Uint8Array([4, 5, 6, 7]).buffer;
    const local: LocalFileEntry = {
      path: "actively-edited.md",
      hash: await sha256Hex(scannedContent),
      size: scannedContent.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentLocal: LocalFileEntry = {
      ...local,
      hash: await sha256Hex(currentContent),
      size: currentContent.byteLength,
      mtime: 2,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-drift",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getDelta }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(currentContent) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: currentLocal }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("result.deferred");
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("settles a proven not-applied download failure in the same sync round", async () => {
    const previousMobile = Platform.isMobile;
    const remote: RemoteFileEntry = {
      path: "offline-download.bin",
      driveId: "remote-offline-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 2,
      eTag: "etag-offline-download",
      cTag: "ctag-offline-download",
      sha256Hash: "aa".repeat(32),
    };
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([remote], [], {
      reconcilePendingIssues,
    });
    const downloadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-offline-download",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    let result;
    try {
      Platform.isMobile = true;
      result = await executor.run("manual", {});
    } finally {
      Platform.isMobile = previousMobile;
    }

    expect(downloadFile).toHaveBeenCalledOnce();
    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.partial");
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(remote);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: remote.path,
        actionType: SyncActionType.Download,
        reason: "syncView.failure.network",
        remoteETag: remote.eTag,
      })],
      new Set(),
    );
  });

  it("checkpoints a verifiably applied upload in the same round after its response is lost", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "response-lost.md",
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-response-lost",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-response-lost",
      cTag: "ctag-response-lost",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-response-lost",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("recovers an applied overwrite after its PUT response is lost when Graph omits SHA-256", async () => {
    const previousContent = new Uint8Array([1, 2, 3]).buffer;
    const content = new Uint8Array([9, 8, 7]).buffer;
    const previousHash = await sha256Hex(previousContent);
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "response-lost-overwrite-no-sha.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remoteBeforeUpload: RemoteFileEntry = {
      path: local.path,
      driveId: "existing-response-lost-item",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: previousContent.byteLength,
      mtime: 1,
      eTag: "etag-before-overwrite",
      cTag: "ctag-before-overwrite",
    };
    const remoteAfterUpload: RemoteFileEntry = {
      ...remoteBeforeUpload,
      size: local.size,
      mtime: 3,
      eTag: "etag-after-overwrite",
      cTag: "ctag-after-overwrite",
      downloadUrl: "https://download.example/response-lost-overwrite-no-sha.md",
    };
    const state = makeActiveV2State(
      [remoteBeforeUpload],
      [{
        path: local.path,
        hash: previousHash,
        size: previousContent.byteLength,
        eTag: remoteBeforeUpload.eTag,
      }],
    );
    let expectedRemoteDuringPut: unknown;
    const uploadFile = vi.fn().mockImplementation(async () => {
      expectedRemoteDuringPut = (
        state.mutationLedger[0] as unknown as {
          intent: { expectedRemote: unknown };
        }
      ).intent.expectedRemote;
      throw new OneDriveError(OneDriveErrorType.NetworkError, "PUT response lost");
    });
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getFileMetadata = vi.fn().mockResolvedValue(remoteAfterUpload);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-overwrite-response-lost",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        downloadFile,
        getFileMetadata,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      expect.any(ArrayBuffer),
      undefined,
      remoteBeforeUpload.eTag,
      remoteBeforeUpload.driveId,
    );
    expect(expectedRemoteDuringPut).toEqual({
      exists: true,
      driveId: remoteBeforeUpload.driveId,
      eTag: remoteBeforeUpload.eTag,
      size: remoteBeforeUpload.size,
      sha256Hash: undefined,
    });
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      remoteAfterUpload.downloadUrl,
      remoteAfterUpload.driveId,
      remoteAfterUpload.size,
    );
    expect(getFileMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 1,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash,
      size: local.size,
      eTag: remoteAfterUpload.eTag,
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: remoteAfterUpload.driveId,
        parentId: remoteAfterUpload.parentId,
        size: remoteAfterUpload.size,
        eTag: remoteAfterUpload.eTag,
        cTag: remoteAfterUpload.cTag,
      }),
    ]);
  });

  it("retains an upload intent when the response is lost and remote facts are ambiguous", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const local: LocalFileEntry = {
      path: "ambiguous-response.md",
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const unrelatedRemote: RemoteFileEntry = {
      path: local.path,
      driveId: "ambiguous-remote-object",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 4,
      mtime: 2,
      eTag: "etag-ambiguous",
      cTag: "ctag-ambiguous",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-ambiguous",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(unrelatedRemote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.syncFailed");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].intent.path).toBe(local.path);
    expect(state.mutationLedger[0].intent.scope).toEqual({
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    });
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
  });

  it("returns a retryable recovery fact when a lost upload response cannot be observed in the same round", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const local: LocalFileEntry = {
      path: "response-lost-observation-offline.md",
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        "upload response lost",
      ),
    );
    const getFileMetadata = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.RateLimited,
        "recovery observation unavailable",
        429,
        19,
      ),
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-upload-offline",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.mutationRecovery).toEqual({
      state: "network-unavailable",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: 19,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(getFileMetadata).toHaveBeenCalledOnce();
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("recovers an applied unreceipted download without downloading the file again", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "downloaded.md",
      hash,
      size: content.byteLength,
      mtime: 4,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-download-receipt-lost",
          planRevision: 1,
          scope: activeScope,
          action: "download",
          path: local.path,
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const downloadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-download-recovered",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("recovers an unreceipted download by stable readback when Graph omits SHA-256", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "downloaded-without-graph-hash.md",
      hash,
      size: content.byteLength,
      mtime: 4,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-download-no-hash",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-download-no-hash",
      cTag: "ctag-download-no-hash",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-download-receipt-lost-no-graph-hash",
          planRevision: 1,
          scope: activeScope,
          action: "download",
          path: local.path,
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
        file: { hashes: {} },
      })],
      "@odata.deltaLink": "https://graph.example/delta-download-readback",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(getFileMetadata).toHaveBeenCalledTimes(3);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("finishes a verified receipt checkpoint before generating a new plan", async () => {
    const hash = "aa".repeat(32);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const remote = {
      path: "note.md",
      driveId: "item-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "",
      sha256Hash: hash,
    };
    const base = { path: "note.md", hash, size: 3, eTag: "etag-note" };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-receipted",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-receipted",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [base],
            baseRemovals: [],
            remoteUpserts: [remote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const local: LocalFileEntry = { path: "note.md", hash, size: 3, mtime: 1, binary: false };
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem("note.md", hash, {
        id: remote.driveId,
        eTag: remote.eTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([base]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      eTag: remote.eTag,
      sha256Hash: remote.sha256Hash,
    }));
  });

  it("rebinds an upload receipt after the remote folder identity is replaced", async () => {
    const hash = "ab".repeat(32);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const folder: RemoteFolderEntry = {
      path: "plugins",
      driveId: "plugins-folder-current",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      name: "plugins",
    };
    const remote: RemoteFileEntry = {
      path: "plugins/note.md",
      driveId: "item-note-current",
      parentId: folder.driveId,
      size: 3,
      mtime: 1,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      sha256Hash: hash,
    };
    const staleReceiptRemote = { ...remote, parentId: "plugins-folder-old" };
    const base = {
      path: remote.path,
      hash,
      size: remote.size,
      eTag: remote.eTag,
    };
    const state = makeActiveV2State([remote], [], {
      remoteFolders: [folder],
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-replaced-parent",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: remote.path,
          expectedLocal: { exists: true, hash, size: remote.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-replaced-parent",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [base],
            baseRemovals: [],
            remoteUpserts: [staleReceiptRemote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder(folder.driveId, folder.name, folder.parentId),
        driveItem(remote.path, hash, {
          id: remote.driveId,
          eTag: remote.eTag,
          cTag: remote.cTag,
          parentReference: { id: folder.driveId },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const local: LocalFileEntry = {
      path: remote.path,
      hash,
      size: remote.size,
      mtime: 1,
      binary: false,
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: folder.path }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: folder.driveId,
      eTag: remote.eTag,
    }));
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-replaced-parent",
      checkpoint: expect.objectContaining({
        remoteUpserts: [expect.objectContaining({
          path: remote.path,
          parentId: folder.driveId,
        })],
      }),
    }));
  });

  it("recovers a cancelled post-upload receipt without uploading the file twice", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = { path: "note.md", hash, size: 3, mtime: 1, binary: false };
    const state = makeActiveV2State([], []);
    let firstExecutor: SyncExecutor;
    const uploadFile = vi.fn().mockImplementation(async () => {
      firstExecutor.cancel();
      return {
        id: "uploaded-note",
        name: "note.md",
        size: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
      };
    });
    const scanner = {
      vault: {
        adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [local],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;
    firstExecutor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      scanner,
      state,
      "testVault",
    );

    const cancelled = await firstExecutor.run("manual", {});

    expect(cancelled.message).toBe("result.cancelled");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
    expect(state.mutationLedger[0].receipt?.checkpoint.remoteUpserts).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "uploaded-note",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-uploaded",
        sha256Hash: hash,
      }),
    ]);
    expect(state.baseSnapshot).toEqual([]);

    const recoveryGetDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-after",
    });
    const recoveryClient = makeMockOneDrive({
      uploadFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        path: "note.md",
        driveId: "uploaded-note",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 3,
        mtime: 2,
        eTag: "etag-uploaded",
        sha256Hash: hash,
      }),
      getDelta: recoveryGetDelta,
    });
    const recoveryWarn = vi.fn();
    const recoveryDiagnostics = {
      isEnabled: vi.fn((category: string) => category === "state"),
      log: vi.fn(),
      warn: recoveryWarn,
      error: vi.fn(),
    } as unknown as DiagnosticLogger;
    const recoveryExecutor = new SyncExecutor(
      recoveryClient,
      scanner,
      state,
      "testVault",
      undefined,
      undefined,
      recoveryDiagnostics,
    );

    await recoveryExecutor.run("manual", {});

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(recoveryGetDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([{
      path: "note.md",
      hash,
      size: 3,
      eTag: "etag-uploaded",
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "note.md", driveId: "uploaded-note", eTag: "etag-uploaded" }),
    ]);
    expect(recoveryWarn.mock.calls).toEqual([]);
  });

  it("purges EasySync internal files from a cached remote snapshot", async () => {
    const internalPath = ".obsidian/plugins/easy-sync/data.sync-conflict-20260709.json";
    const remoteFolders: RemoteFolderEntry[] = [
      { path: ".obsidian", driveId: "obsidian-folder", parentId: TEST_SYNC_SCOPE.filesRootId, name: ".obsidian" },
      { path: ".obsidian/plugins", driveId: "plugins-folder", parentId: "obsidian-folder", name: "plugins" },
      { path: ".obsidian/plugins/easy-sync", driveId: "easy-sync-folder", parentId: "plugins-folder", name: "easy-sync" },
    ];
    const state = makeActiveV2State([{
      path: internalPath,
      driveId: "internal-id",
      parentId: "easy-sync-folder",
      size: 10,
      mtime: 1,
      eTag: "internal-etag",
      cTag: "internal-ctag",
    }], [], { remoteFolders });
    const downloadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-2",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(false),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.remoteSnapshot).toEqual([]);
  });

  it("applies the local sync scope to remote plugin files", async () => {
    const mainHash = "aa".repeat(32);
    const localMain: LocalFileEntry = {
      path: ".obsidian/plugins/example-plugin/main.js",
      hash: mainHash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([], []);
    const downloadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder("obsidian-folder", ".obsidian", "files-root-id"),
        graphFolder("plugins-folder", "plugins", "obsidian-folder"),
        graphFolder("example-plugin-folder", "example-plugin", "plugins-folder"),
        graphFolder("runtime-folder", "runtime", "example-plugin-folder"),
        driveItem("main.js", mainHash, {
          id: "main-id",
          parentReference: {
            id: "example-plugin-folder",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/.obsidian/plugins/example-plugin",
          },
        }),
        driveItem("cache.json", "bb".repeat(32), {
          id: "cache-id",
          parentReference: {
            id: "runtime-folder",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/.obsidian/plugins/example-plugin/runtime",
          },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-1",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        shouldSyncPath: vi.fn((path: string) => !path.includes("/runtime/")),
        shouldSyncFolderPath: vi.fn((path: string) => !path.endsWith("/runtime")),
        scanAll: vi.fn().mockResolvedValue({
          entries: [localMain],
          folders: [
            { path: ".obsidian" },
            { path: ".obsidian/plugins" },
            { path: ".obsidian/plugins/example-plugin" },
          ],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: localMain }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual([
      ".obsidian/plugins/example-plugin/main.js",
    ]);
  });

  it("rebuilds a remote cache when its delta link belongs to another vault directory", async () => {
    const state = makeActiveV2State([{
      path: "stale.md",
      driveId: "stale-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "stale-etag",
      cTag: "stale-ctag",
    }], []);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/legacy-delta",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        isDeltaLinkForVault: vi.fn().mockReturnValue(false),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/legacy-delta");
  });

  it("applies additions and tombstones across consecutive V2 delta rounds", async () => {
    const hashA = "aa".repeat(32);
    const downloaded = new Uint8Array([1, 2, 3]).buffer;
    const hashB = await sha256Hex(downloaded);
    const state = makeActiveV2State([], []);
    let scanRound = 0;
    let downloadWritten = false;
    const files = new Map<string, ArrayBuffer>();
    const adapter = makeMockAdapter({
      appendBinary: undefined,
      readBinary: vi.fn().mockImplementation(async (path: string) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing: ${path}`);
        return content;
      }),
      writeBinary: vi.fn().mockImplementation(async (path: string, content: ArrayBuffer) => {
        files.set(path, content.slice(0));
        if (path === "b.md") downloadWritten = true;
      }),
      stat: vi.fn().mockImplementation(async (path: string) => {
        const content = files.get(path);
        return content ? { type: "file", size: content.byteLength, mtime: 1, ctime: 1 } : null;
      }),
      rename: vi.fn().mockImplementation(async (from: string, to: string) => {
        const content = files.get(from);
        if (!content) throw new Error(`missing: ${from}`);
        files.set(to, content);
        files.delete(from);
        if (to === "b.md") downloadWritten = true;
      }),
      remove: vi.fn().mockImplementation(async (path: string) => {
        files.delete(path);
      }),
    });
    const getDelta = vi.fn(async (_vaultName: string, deltaLink?: string) => {
      if (deltaLink === "delta-token") {
        return {
          value: [driveItem("a.md", hashA)],
          "@odata.deltaLink": "https://graph.example/delta-1",
        };
      }
      if (deltaLink.endsWith("delta-1")) {
        return {
          value: [driveItem("b.md", hashB)],
          "@odata.deltaLink": "https://graph.example/delta-2",
        };
      }
      return {
        value: [driveItem("b.md", hashB, {
          id: "item-b.md",
          file: undefined,
          deleted: { state: "deleted" },
        })],
        "@odata.deltaLink": "https://graph.example/delta-3",
      };
    });
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        downloadFile,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockImplementation(async () => {
          scanRound++;
          return {
            entries: scanRound === 1
              ? [{ path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false }]
              : scanRound === 2
                ? [{ path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false }]
                : [
                    { path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false },
                    { path: "b.md", size: 3, mtime: 1, hash: hashB, binary: false },
                  ],
            folders: [],
            folderScanComplete: true,
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          };
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) => (
          path === "a.md" || scanRound >= 3 || downloadWritten
            ? {
                status: "present",
                entry: {
                  path,
                  size: 3,
                  mtime: 1,
                  hash: path === "a.md" ? hashA : hashB,
                  binary: false,
                },
              }
            : { status: "missing" }
        )),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const first = await executor.run("manual", {});
    expect(first.success).toBe(true);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");

    const second = await executor.run("manual", {});
    expect(second.success).toBe(true);
    expect(second.downloaded).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot.map((entry) => entry.path).sort()).toEqual(["a.md", "b.md"]);
    expect(state.baseSnapshot).toContainEqual({
      path: "b.md",
      hash: hashB,
      size: 3,
      eTag: "etag-b.md",
    });
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");

    const third = await executor.run("manual", {});
    expect(third.conflicts).toBe(1);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-3");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      "https://graph.example/delta-1",
      "https://graph.example/delta-2",
    ]);
  });

  it("coalesces duplicate drive ids by the last delta occurrence", async () => {
    const latestHash = "bb".repeat(32);
    const local: LocalFileEntry = {
      path: "latest.md",
      hash: latestHash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([{
      path: "old.md",
      driveId: "shared-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    }], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [
            driveItem("middle.md", "aa".repeat(32), { id: "shared-id" }),
            driveItem("latest.md", latestHash, { id: "shared-id" }),
          ],
          "@odata.deltaLink": "https://graph.example/delta-2",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toHaveLength(1);
    expect(state.remoteSnapshot[0]).toEqual(expect.objectContaining({
      path: "latest.md",
      driveId: "shared-id",
    }));
  });

  it("Preflight P0 — file delta without parent identity does not invent a root path", async () => {
    const hash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "nested/note.md",
      driveId: "note-id",
      parentId: "nested-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "nested",
        driveId: "nested-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "nested",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [driveItem("note.md", "cc".repeat(32), {
            id: "note-id",
            parentReference: undefined,
            eTag: "etag-new",
          })],
          "@odata.deltaLink": "https://graph.example/delta-2",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "nested" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("delta-token");
  });

  it("rebuilds a complete identity snapshot when a folder delta changes a V2 path", async () => {
    const currentHash = "cc".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const local: LocalFileEntry = {
      path: "new-folder/child.md",
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "new-folder",
          folder: { childCount: 1 },
          parentReference: {
            id: "files-root-id",
          },
          eTag: "etag-folder-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "new-folder",
          folder: { childCount: 1 },
          parentReference: {
            id: "files-root-id",
          },
          eTag: "etag-folder-new",
        }, {
          id: "child-id",
          name: "child.md",
          size: 3,
          file: { hashes: { sha256Hash: currentHash } },
          parentReference: {
            id: "folder-id",
          },
          eTag: "etag-child-new",
          cTag: "ctag-child-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "new-folder" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "new-folder/child.md",
        driveId: "child-id",
        eTag: "etag-child-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
  });

  it("A0-P — keeps one delta page for a proven unchanged parent folder notification", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/graph-live-contract-success-20260717.json", import.meta.url),
      "utf8",
    )) as { deltaPages: Array<{ value: DriveItem[] }> };
    const capturedFolderMutation = fixture.deltaPages
      .flatMap((page) => page.value)
      .find((item) => item.folder);
    expect(capturedFolderMutation).toBeDefined();
    const hash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "Fragments",
        driveId: "fragments-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Fragments",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        ...capturedFolderMutation,
        id: "fragments-folder-id",
        name: "Fragments",
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        eTag: "etag-fragments-new",
      }],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Fragments" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith(
      "testVault",
      "delta-token",
    );
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("updates a V2 root file from the known files root without rebuilding", async () => {
    const currentHash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "main.js",
      driveId: "main-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], []);
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const updatedItem = driveItem("main.js", currentHash, {
      id: cachedEntry.driveId,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      eTag: "etag-new",
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [updatedItem],
        "@odata.deltaLink": "https://graph.example/delta-2",
      })
      .mockResolvedValueOnce({
        value: [updatedItem],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: cachedEntry.path,
        driveId: cachedEntry.driveId,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("keeps one delta page for an unchanged folder with no directly cached files", async () => {
    const hash = "aa".repeat(32);
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "note-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([remote], [], {
      remoteFolders: [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    });
    const local: LocalFileEntry = {
      path: remote.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const folderNotification: DriveItem = {
      id: "empty-folder-id",
      name: "Empty",
      folder: { childCount: 0 },
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      eTag: "etag-empty-new",
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [folderNotification],
        "@odata.deltaLink": "https://graph.example/delta-2",
      })
      .mockResolvedValueOnce({
        value: [folderNotification],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Empty" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("projects a new file inside a persisted folder without a full rebuild", async () => {
    const hash = "aa".repeat(32);
    const state = makeActiveV2State([], [], {
      remoteFolders: [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    });
    const local: LocalFileEntry = {
      path: "Empty/new.md",
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        {
          id: "empty-folder-id",
          name: "Empty",
          folder: { childCount: 1 },
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        },
        driveItem("new.md", hash, {
          id: "new-file-id",
          parentReference: { id: "empty-folder-id" },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Empty" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Empty/new.md",
        driveId: "new-file-id",
        parentId: "empty-folder-id",
      }),
    ]);
  });

  it("applies file changes from the same page as an unchanged parent folder notification", async () => {
    const currentHash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note-old",
      cTag: "ctag-note-old",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "Fragments",
        driveId: "fragments-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Fragments",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "fragments-folder-id",
        name: "Fragments",
        folder: { childCount: 1 },
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        eTag: "etag-fragments-new",
      }, driveItem("note.md", currentHash, {
        id: "note-id",
        parentReference: { id: "fragments-folder-id" },
        eTag: "etag-note-new",
      })],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Fragments" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Fragments/note.md",
        driveId: "note-id",
        eTag: "etag-note-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("rebuilds instead of ignoring deletion of the known files root", async () => {
    const state = makeActiveV2State([{
      path: "note.md",
      driveId: "note-id",
      parentId: "files-root-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: "aa".repeat(32),
    }], []);
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: TEST_SYNC_SCOPE.filesRootId,
          name: "files",
          deleted: { state: "deleted" },
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("projects a complete Graph-shaped snapshot from the known files root only", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/graph-live-contract-success-20260717.json", import.meta.url),
      "utf8",
    )) as { deltaPages: Array<{ value: DriveItem[] }> };
    const capturedItems = fixture.deltaPages.flatMap((page) => page.value);
    const capturedFolder = capturedItems.find((item) => item.name === "Nested 中文" && item.folder);
    const capturedFile = capturedItems.find((item) => item.name === "child.md" && item.file && !item.deleted);
    expect(capturedFolder).toBeDefined();
    expect(capturedFile).toBeDefined();

    const contentHash = "aa".repeat(32);
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 5,
      mtime: 1,
      eTag: "etag-child-old",
      cTag: "ctag-child-old",
      sha256Hash: contentHash,
    }], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const local: LocalFileEntry = {
      path: "Nested 中文/child.md",
      hash: contentHash,
      size: 5,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "Nested 中文",
          folder: { childCount: 1 },
          parentReference: { id: "files-root-id" },
          eTag: "etag-folder-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "vault-root-id",
          name: "testVault",
          folder: { childCount: 2 },
          parentReference: { id: "app-root-id" },
        }, {
          id: "files-root-id",
          name: "files",
          folder: { childCount: 1 },
          parentReference: { id: "vault-root-id" },
        }, {
          id: "plugin-root-id",
          name: ".easy-sync",
          folder: { childCount: 1 },
          parentReference: { id: "vault-root-id" },
        }, {
          ...capturedFolder,
          id: "folder-id",
          name: "Nested 中文",
          deleted: undefined,
          parentReference: { id: "files-root-id" },
        }, {
          ...capturedFile,
          id: "child-id",
          name: "child.md",
          deleted: undefined,
          parentReference: { id: "folder-id" },
          lastModifiedDateTime: "2026-07-17T00:00:00.000Z",
          file: {
            ...capturedFile!.file,
            hashes: {
              ...capturedFile!.file?.hashes,
              sha256Hash: contentHash,
            },
          },
        }, {
          id: "internal-id",
          name: "baseline.json",
          size: 5,
          file: { hashes: { sha256Hash: "dd".repeat(32) } },
          parentReference: { id: "plugin-root-id" },
        } satisfies DriveItem],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        initVaultScope: vi.fn().mockResolvedValue({
          driveId: "drive-id",
          vaultFolderId: "vault-folder-id",
          filesRootId: "files-root-id",
        }),
        getDelta,
      }),
      {
        ...emptyScanner(),
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Nested 中文" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Nested 中文/child.md",
        driveId: "child-id",
      }),
    ]);
    expect(state.remoteSnapshot.every((entry) => !entry.path.startsWith("files/"))).toBe(true);
    expect(state.remoteSnapshot.every((entry) => !entry.path.startsWith(".easy-sync/"))).toBe(true);
    expect(state.remoteFolders).toEqual([
      expect.objectContaining({
        path: "Nested 中文",
        driveId: "folder-id",
        parentId: "files-root-id",
        name: "Nested 中文",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("keeps the last healthy cache and stops planning on a network delta failure", async () => {
    const cachedEntry: RemoteFileEntry = {
      path: "keep.md",
      driveId: "keep-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "keep-etag",
      cTag: "keep-ctag",
    };
    const state = makeActiveV2State([cachedEntry], []);
    const getDelta = vi.fn().mockRejectedValue(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));
    const fullScan = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta, fullScan }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(fullScan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["keep.md"]);
    expect(state.remoteDeltaLink).toBe("delta-token");
  });

  it("applies successful uploads and remote deletes to the cached view", async () => {
    const removedRemote: RemoteFileEntry = {
      path: "remove.md",
      driveId: "remove-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-remove",
      cTag: "ctag-remove",
    };
    const removedBase: BaseFileEntry = {
      path: removedRemote.path,
      size: removedRemote.size,
      hash: "bb".repeat(32),
      eTag: removedRemote.eTag,
    };
    const state = makeActiveV2State([removedRemote], [removedBase]);
    const uploadLocal: LocalFileEntry = {
      path: "upload.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const adapter = makeMockAdapter();
    const uploadFile = vi.fn().mockResolvedValue({
      id: "upload-id",
      name: uploadLocal.path,
      size: uploadLocal.size,
      eTag: "etag-upload",
      cTag: "ctag-upload",
      lastModifiedDateTime: "2026-07-10T00:00:00.000Z",
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    });
    const deleteItem = vi.fn().mockResolvedValue(undefined);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "https://graph.example/delta-2" }),
        uploadFile,
        deleteItem,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [uploadLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          path === uploadLocal.path ? uploadLocal : null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.uploaded).toBe(1);
    expect(result.deleted).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(deleteItem).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["upload.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });
});

describe("Remote sha256 dedup", () => {
  function makePendingConflictStore(initial: SyncPlanItem[]) {
    const pendingConflicts = initial.map((item) => ({ ...item }));
    const upsertPendingConflicts = vi.fn(async (items: SyncPlanItem[]) => {
      for (const item of items) {
        const index = pendingConflicts.findIndex((current) => current.path === item.path);
        if (index >= 0) pendingConflicts[index] = item;
        else pendingConflicts.push(item);
      }
    });
    const prunePendingConflicts = vi.fn(async (paths: Iterable<string>) => {
      const active = new Set(paths);
      pendingConflicts.splice(
        0,
        pendingConflicts.length,
        ...pendingConflicts.filter((item) => active.has(item.path)),
      );
    });
    return {
      pendingConflicts,
      upsertPendingConflicts,
      prunePendingConflicts,
    };
  }

  it("retries an unchanged pending conflict that has never completed byte comparison", async () => {
    const path = "quickadd-main.js";
    const content = new TextEncoder().encode("same plugin code").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-quickadd",
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-quickadd",
      cTag: "ctag-quickadd",
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.newFileBothSides",
    };
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([conflict]);
    const state = makeActiveV2State([remote], [], pendingStore);

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(state.baseSnapshot).toEqual([{
      path,
      hash,
      size: content.byteLength,
      eTag: remote.eTag,
    }]);
    expect(pendingStore.pendingConflicts).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it("does not redownload an unchanged pending conflict with a version-bound different receipt", async () => {
    const path = "quickadd-main.js";
    const local: LocalFileEntry = {
      path,
      size: 16,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-quickadd",
      size: 16,
      mtime: 2,
      eTag: "etag-quickadd",
      cTag: "ctag-quickadd",
    };
    const conflict = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.newFileBothSides",
      contentComparison: {
        version: 1,
        result: "different",
        localHash: local.hash,
        localSize: local.size,
        remoteDriveId: remote.driveId,
        remoteETag: remote.eTag,
        remoteSize: remote.size,
        remoteHash: "bb".repeat(32),
      },
    } as SyncPlanItem;
    const downloadFile = vi.fn();
    const establishedLocal: LocalFileEntry = {
      path: "established.md",
      hash: "cc".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const establishedRemote: RemoteFileEntry = {
      path: establishedLocal.path,
      driveId: "established-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: establishedLocal.size,
      mtime: 1,
      eTag: "etag-established",
      cTag: "",
      sha256Hash: establishedLocal.hash,
    };
    const pendingStore = makePendingConflictStore([conflict]);
    const state = makeActiveV2State(
      [remote, establishedRemote],
      [{
        path: establishedLocal.path,
        hash: establishedLocal.hash,
        size: establishedLocal.size,
        eTag: establishedRemote.eTag,
      }],
      pendingStore,
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, establishedLocal],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          candidatePath === path ? local : establishedLocal),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});

    expect(downloadFile).not.toHaveBeenCalled();
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        path,
        contentComparison: conflict.contentComparison,
      }),
    ]);
    expect(result.conflicts).toBe(1);
  });

  it("persists a byte-difference receipt so the next round does not download the same versions again", async () => {
    const path = "real-conflict.bin";
    const localContent = new TextEncoder().encode("local-content").buffer;
    const remoteContent = new TextEncoder().encode("remote-conten").buffer;
    expect(localContent.byteLength).toBe(remoteContent.byteLength);
    const local: LocalFileEntry = {
      path,
      size: localContent.byteLength,
      mtime: 1,
      hash: await sha256Hex(localContent),
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "real-conflict-id",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-real-conflict",
      cTag: "ctag-real-conflict",
    };
    const base: BaseFileEntry = {
      path,
      hash: "cc".repeat(32),
      size: local.size,
      eTag: "etag-before-conflict",
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.bothSidesModified",
    };
    const pendingStore = makePendingConflictStore([]);
    const downloadFile = vi.fn().mockResolvedValue(remoteContent);
    const state = makeActiveV2State([remote], [base], pendingStore);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const first = await executor.run("manual", {});
    const second = await executor.run("manual", {});

    expect(first.conflicts).toBe(1);
    expect(second.conflicts).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(pendingStore.pendingConflicts).toEqual([
      expect.objectContaining({
        path,
        contentComparison: expect.objectContaining({
          version: 1,
          result: "different",
          localHash: local.hash,
          remoteDriveId: remote.driveId,
          remoteETag: remote.eTag,
          remoteHash: await sha256Hex(remoteContent),
        }),
      }),
    ]);
  });

  it("resolves identical new binary files without downloading remote content", async () => {
    const path = "recording.m4a";
    const hash = "14731cbf60b9c1b219e31ab5a1b71bda45a0a4c3f137c0e0fa7f4ca1ad54a069";
    const local: LocalFileEntry = {
      path,
      size: 42534604,
      mtime: 1,
      hash,
      binary: true,
    };
    const downloadFile = vi.fn();
    const state = makeActiveV2State([], []);

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            {
              id: "item-recording",
              name: "recording.m4a",
              size: 42534604,
              eTag: "etag-recording",
              cTag: "ctag-recording",
              lastModifiedDateTime: "2026-07-08T14:48:59.000Z",
              parentReference: {
                id: TEST_SYNC_SCOPE.filesRootId,
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
              },
              file: {
                mimeType: "audio/mp4",
                hashes: {
                  sha256Hash: hash.toUpperCase(),
                },
              },
            },
          ],
          "@odata.deltaLink": "tok",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      {
        path,
        hash,
        size: 42534604,
        eTag: "etag-recording",
      },
    ]);
  });

  it("resolves every metadata-hash match even when there are more than ten", async () => {
    const hash = "ab".repeat(32);
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: 16,
      mtime: 1,
      hash,
      binary: true,
    }));
    const downloadFile = vi.fn();
    const state = makeActiveV2State([], []);
    const remoteItems: DriveItem[] = paths.map((path, index) => ({
      id: `item-${index}`,
      name: path,
      size: 16,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: TEST_SYNC_SCOPE.filesRootId,
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: hash.toUpperCase() } },
    }));

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({ value: remoteItems, "@odata.deltaLink": "tok" }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toHaveLength(20);
    expect(state.baseSnapshot.every((entry) => entry.hash === hash)).toBe(true);
  });

  it("absorbs an eTag-only remote change without downloading identical content", async () => {
    const path = "recording.m4a";
    const hash = "cd".repeat(32);
    const local: LocalFileEntry = {
      path,
      size: 1024,
      mtime: 1,
      hash,
      binary: true,
    };
    const base: BaseFileEntry = {
      path,
      hash,
      size: 1024,
      eTag: "upload-etag-v1",
    };
    const remoteBeforeDelta: RemoteFileEntry = {
      path,
      driveId: "recording-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1024,
      mtime: 1,
      eTag: base.eTag,
      cTag: "ctag-v1",
      sha256Hash: hash,
    };
    const downloadFile = vi.fn();
    const state = makeActiveV2State([remoteBeforeDelta], [base]);

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            {
              id: "recording-id",
              name: "recording.m4a",
              size: 1024,
              eTag: "delta-etag-v2",
              cTag: "ctag",
              lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
              parentReference: {
                id: TEST_SYNC_SCOPE.filesRootId,
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
              },
              file: { hashes: { sha256Hash: hash.toUpperCase() } },
            },
          ],
          "@odata.deltaLink": "tok",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([{
      path,
      hash,
      size: 1024,
      eTag: "delta-etag-v2",
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path,
        driveId: remoteBeforeDelta.driveId,
        eTag: "delta-etag-v2",
        sha256Hash: hash,
      }),
    ]);
  });

  it("reconciles one eTag-only change while an unrelated path remains a conflict", async () => {
    const equalHash = "21".repeat(32);
    const baseConflictHash = "43".repeat(32);
    const localConflictHash = "65".repeat(32);
    const remoteConflictHash = "87".repeat(32);
    const equalLocal: LocalFileEntry = {
      path: "equal-after-etag.bin",
      size: 10,
      mtime: 1,
      hash: equalHash,
      binary: true,
    };
    const conflictLocal: LocalFileEntry = {
      path: "independent-conflict.bin",
      size: 12,
      mtime: 2,
      hash: localConflictHash,
      binary: true,
    };
    const equalRemote: RemoteFileEntry = {
      path: equalLocal.path,
      driveId: "equal-after-etag-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: equalLocal.size,
      mtime: 1,
      eTag: "equal-etag-v1",
      cTag: "equal-ctag-v1",
      sha256Hash: equalHash,
    };
    const conflictRemote: RemoteFileEntry = {
      path: conflictLocal.path,
      driveId: "independent-conflict-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: conflictLocal.size,
      mtime: 1,
      eTag: "conflict-etag-v1",
      cTag: "conflict-ctag-v1",
      sha256Hash: baseConflictHash,
    };
    const equalBase: BaseFileEntry = {
      path: equalRemote.path,
      hash: equalHash,
      size: equalRemote.size,
      eTag: equalRemote.eTag,
    };
    const conflictBase: BaseFileEntry = {
      path: conflictRemote.path,
      hash: baseConflictHash,
      size: conflictRemote.size,
      eTag: conflictRemote.eTag,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [equalRemote, conflictRemote],
      [equalBase, conflictBase],
      { upsertPendingConflicts },
    );
    const downloadFile = vi.fn();
    const oneDrive = makeMockOneDrive({
      downloadFile,
      getDelta: vi.fn().mockResolvedValue({
        value: [
          {
            id: equalRemote.driveId,
            name: equalRemote.path,
            size: equalRemote.size,
            eTag: "equal-etag-v2",
            cTag: "equal-ctag-v2",
            lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
            parentReference: {
              id: TEST_SYNC_SCOPE.filesRootId,
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: equalHash.toUpperCase() } },
          },
          {
            id: conflictRemote.driveId,
            name: conflictRemote.path,
            size: conflictRemote.size,
            eTag: "conflict-etag-v2",
            cTag: "conflict-ctag-v2",
            lastModifiedDateTime: "2026-07-10T12:00:01.000Z",
            parentReference: {
              id: TEST_SYNC_SCOPE.filesRootId,
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: {
              hashes: { sha256Hash: remoteConflictHash.toUpperCase() },
            },
          },
        ],
        "@odata.deltaLink": "tok",
      }),
    });
    const localEntries = [equalLocal, conflictLocal];
    const executor = new SyncExecutor(
      oneDrive,
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(oneDrive.uploadFile).not.toHaveBeenCalled();
    expect(oneDrive.deleteItem).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      {
        ...equalBase,
        eTag: "equal-etag-v2",
      },
      conflictBase,
    ]);
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: conflictLocal.path,
      }),
    ]);
  });

  it("downloads every candidate during bootstrap when remote metadata has no sha256", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 20 }, (_, index) => `no-hash-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    }));
    const remoteEntries: RemoteFileEntry[] = paths.map((path, index) => ({
      path,
      driveId: `no-hash-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 2,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(remoteEntries, [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `no-hash-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-${index}`,
            } : null);
          },
        ),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(20);
    expect(state.baseSnapshot).toHaveLength(20);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
  });

  it("retains a proven QuickXor mismatch during bootstrap without downloading it", async () => {
    const path = "quickxor-mismatch.bin";
    const item: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        size: 8,
        mtime: 1,
        hash: "aa".repeat(32),
        quickXorHash: "local-quickxor",
        binary: true,
      },
      remote: {
        path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 8,
        mtime: 2,
        eTag: "etag-remote",
        cTag: "ctag-remote",
        quickXorHash: "remote-quickxor",
      },
      reason: "reason.newFileBothSides",
    };
    const downloadFile = vi.fn();
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State([item.remote!], [], {
      ...pendingStore,
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [item.local!],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(item.local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).not.toHaveBeenCalled();
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({ path }),
    ]);
    expect(pendingStore.upsertPendingConflicts.mock.calls[0]![0]![0]).not.toHaveProperty(
      "contentComparison",
    );
    expect(result.conflicts).toBe(1);
  });

  it("finishes byte comparison for every unseeded path while rebuilding an empty base", async () => {
    const content = new TextEncoder().encode("same reset content").buffer;
    const hash = await sha256Hex(content);
    const seededPath = "seeded.md";
    const unseededPaths = Array.from(
      { length: 11 },
      (_, index) => `reset-no-hash-${index}.bin`,
    );
    const allPaths = [seededPath, ...unseededPaths];
    const localEntries: LocalFileEntry[] = allPaths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: path !== seededPath,
    }));
    const remoteEntries: RemoteFileEntry[] = [
      {
        path: seededPath,
        driveId: "seeded-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 1,
        eTag: "etag-seeded",
        cTag: "ctag-seeded",
        sha256Hash: hash,
      },
      ...unseededPaths.map((path, index) => ({
        path,
        driveId: `reset-no-hash-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 1,
        eTag: `etag-reset-${index}`,
        cTag: `ctag-reset-${index}`,
      })),
    ];
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(remoteEntries, [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = unseededPaths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `reset-no-hash-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-reset-${index}`,
            } : null);
          },
        ),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(unseededPaths.length);
    expect(state.baseSnapshot).toHaveLength(allPaths.length);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
  });

  it("continues an interrupted reset reconstruction after some equal bases were already persisted", async () => {
    const content = new TextEncoder().encode("same legacy pending content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from(
      { length: 11 },
      (_, index) => `legacy-pending-${index}.bin`,
    );
    const conflicts: SyncPlanItem[] = paths.map((path, index) => ({
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        size: content.byteLength,
        mtime: 1,
        hash,
        binary: true,
      },
      remote: {
        path,
        driveId: `legacy-pending-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 2,
        eTag: `etag-legacy-pending-${index}`,
        cTag: `ctag-legacy-pending-${index}`,
      },
      reason: "reason.newFileBothSides",
    }));
    const reconciledLocal: LocalFileEntry = {
      path: "already-reconciled.md",
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const reconciledRemote: RemoteFileEntry = {
      path: reconciledLocal.path,
      driveId: "already-reconciled-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 1,
      eTag: "etag-already-reconciled",
      cTag: "",
      sha256Hash: hash,
    };
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore(conflicts);
    const state = makeActiveV2State(
      [reconciledRemote, ...conflicts.map((item) => item.remote!)],
      [{
        path: reconciledLocal.path,
        hash,
        size: content.byteLength,
        eTag: reconciledRemote.eTag,
      }],
      {
        ...pendingStore,
        // A partial reconstruction has already committed some equal bases,
        // but the first fully healthy round has not completed yet.
        lastSyncTime: 0,
      },
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? conflicts[index].remote : null);
          },
        ),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [reconciledLocal, ...conflicts.map((item) => item.local!)],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          candidatePath === reconciledLocal.path
            ? reconciledLocal
            : conflicts.find((item) => item.path === candidatePath)?.local ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(paths.length);
    expect(state.baseSnapshot).toHaveLength(paths.length + 1);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(pendingStore.pendingConflicts).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it("keeps a conflict when the remote version changes during hash dedup download", async () => {
    const path = "raced.bin";
    const content = new TextEncoder().encode("same before remote race").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "raced-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-before",
      cTag: "ctag-before",
    };
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State([remote], [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(content),
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: remote.driveId,
          size: remote.size,
          mtime: 3,
          eTag: "etag-after",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.baseSnapshot).toEqual([]);
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledTimes(1);
    expect(pendingStore.pendingConflicts).toEqual([
      expect.objectContaining({ path }),
    ]);
    expect(result.conflicts).toBe(1);
  });

  it("caps download-based hash dedup at ten candidates for an established vault", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 11 }, (_, index) => `established-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    }));
    const remoteEntries: RemoteFileEntry[] = paths.map((path, index) => ({
      path,
      driveId: `established-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 1,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(
      remoteEntries,
      [{
        path: paths[0],
        hash: "00".repeat(32),
        size: content.byteLength,
        eTag: "etag-old",
      }],
      {
        ...pendingStore,
        lastSyncTime: 1,
      },
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `established-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-${index}`,
            } : null);
          },
        ),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(10);
    expect(state.baseSnapshot).toHaveLength(10);
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledTimes(1);
    expect(pendingStore.pendingConflicts).toHaveLength(1);
    expect(result.conflicts).toBe(1);
  });
});

describe("Pending item batching", () => {
  it("adds decision tokens before a pending plan is paused for review", async () => {
    const local: LocalFileEntry = {
      path: "reviewed.md",
      size: 8,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const base: BaseFileEntry = {
      path: local.path,
      size: local.size,
      hash: "bb".repeat(32),
      eTag: "etag-old",
    };
    const newLocal: LocalFileEntry = {
      path: "new-upload.md",
      size: 8,
      mtime: 1,
      hash: "cc".repeat(32),
      binary: false,
    };
    const mockState = makeActiveV2State([], [base], {
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const onConfirmThreshold = vi.fn().mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, newLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", { onConfirmThreshold });

    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({
        path: local.path,
        decisionToken: expect.objectContaining({
          version: 1,
          vaultName: "testVault",
          accountId: "account-id",
          ancestorHash: base.hash,
        }),
      })]),
    }));
  });

  it("persists a large conflict plan through one batch call", async () => {
    const localEntries = Array.from({ length: 1000 }, (_, index): LocalFileEntry => ({
      path: `conflict-${index}.md`,
      size: 1,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    }));
    const remoteEntries = localEntries.map((local, index): RemoteFileEntry => ({
      path: local.path,
      driveId: `remote-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      sha256Hash: "bb".repeat(32),
    }));
    const addPendingConflict = vi.fn();
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State(remoteEntries, [], {
      addPendingConflict,
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1000);
    expect(upsertPendingConflicts).toHaveBeenCalledTimes(1);
    const persisted = upsertPendingConflicts.mock.calls[0][0] as SyncPlanItem[];
    expect(persisted.map((item) => item.path)).toEqual(
      localEntries.map((item) => item.path).sort((left, right) => left.localeCompare(right)),
    );
    expect(persisted.every((item) => item.decisionToken?.version === 1)).toBe(true);
    expect(addPendingConflict).not.toHaveBeenCalled();
  });
});

describe("Cancellation checkpoint semantics", () => {
  it("does not record an aborted in-flight transfer as a sync failure after user cancellation", async () => {
    let executor: SyncExecutor;
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: "cancelled.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
    };
    const executorState = makeActiveV2State([remote], [], {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
      reconcilePendingIssues,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockImplementation(async () => {
          executor.cancel();
          throw abortError;
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      executorState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(result.errors).toBe(0);
    expect(result.metrics?.fileTransfers.download).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 1,
      skipped: 0,
      logicalBytes: 0,
      peakConcurrency: 1,
    });
    expect(reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("records a durable receipt but commits no shared state after cancellation", async () => {
    let executor: SyncExecutor;
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockImplementation(async () => {
      executor.cancel();
      return {
        id: "uploaded-id",
        name: "first.md",
        size: 3,
        eTag: "uploaded-etag",
        cTag: "uploaded-ctag",
      };
    });
    const localEntries = ["first.md", "second.md"].map((path): LocalFileEntry => ({
      path,
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    }));
    const mockState = makeActiveV2State([], [], {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
      lastSyncTime: 0,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(mockState.recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(mockState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mockState.mutationLedger).toEqual([
      expect.objectContaining({ receipt: expect.objectContaining({ operationId: expect.any(String) }) }),
    ]);
    expect(mockState.baseSnapshot).toEqual([]);
    expect(mockState.remoteSnapshot).toEqual([]);
    expect(mockState.reconcilePendingIssues).not.toHaveBeenCalled();
    expect(setLastSyncTime).not.toHaveBeenCalled();
  });

  it("keeps a receipt when a local download succeeds but its checkpoint save fails", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const commitMutationCheckpoint = vi.fn().mockRejectedValue(new Error("checkpoint save failed"));
    const remote: RemoteFileEntry = {
      path: "downloaded.bin",
      driveId: "remote-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([remote], [], {
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    state.recordMutationReceipt = recordMutationReceipt;
    state.commitMutationCheckpoint = commitMutationCheckpoint;
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile: vi.fn().mockResolvedValue(content) }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary, stat: vi.fn().mockResolvedValue({ size: 3, mtime: 2 }) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(writeBinary).toHaveBeenCalledWith(remote.path, content);
    expect(recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(state.upsertBaseEntries).not.toHaveBeenCalled();
    expect(result.errors).toBe(1);
  });

  it("keeps the completed item checkpoint when cancellation happens after its completion callback", async () => {
    let executor: SyncExecutor;
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const local: LocalFileEntry = {
      path: "checkpoint.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockResolvedValue({
          id: "uploaded-id",
          name: local.path,
          size: local.size,
          eTag: "uploaded-etag",
          cTag: "uploaded-ctag",
          lastModifiedDateTime: "2026-07-10T00:00:00.000Z",
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {
      onFileComplete: () => executor.cancel(),
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(mockState.mutationLedger).toEqual([]);
    expect(mockState.baseSnapshot).toEqual([
      expect.objectContaining({ path: local.path, hash: local.hash }),
    ]);
    expect(mockState.remoteSnapshot).toEqual([
      expect.objectContaining({ path: local.path, driveId: "uploaded-id" }),
    ]);
    expect(reconcilePendingIssues).not.toHaveBeenCalled();
    expect(setLastSyncTime).not.toHaveBeenCalled();
  });

  it("defers upload hash drift without creating a manual issue", async () => {
    const original = new TextEncoder().encode("same").buffer;
    const changed = new TextEncoder().encode("changed").buffer;
    const originalHash = await sha256Hex(original);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn();
    const local: LocalFileEntry = {
      path: "note.md",
      size: original.byteLength,
      mtime: 1,
      hash: originalHash,
      binary: false,
    };
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(changed) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("result.deferred");
    expect(reconcilePendingIssues).toHaveBeenCalledWith([], expect.any(Set));
    expect(mockState.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("records download write failures as pending issues instead of dropping them", async () => {
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: "broken.bin",
      driveId: "broken-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 4,
      mtime: 1,
      eTag: "broken-etag",
      cTag: "broken-ctag",
      sha256Hash: await sha256Hex(
        new TextEncoder().encode("data").buffer,
      ),
    };
    const state = makeActiveV2State([remote], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode("data").buffer),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockRejectedValue(new Error("missing")),
            writeBinary: vi.fn().mockRejectedValue(new Error("disk full")),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        inspectFile: vi.fn().mockResolvedValue({
          status: "missing",
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.metrics?.fileTransfers.download).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      skipped: 0,
      logicalBytes: 0,
      peakConcurrency: 1,
    });
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "broken.bin", actionType: SyncActionType.Download })],
      expect.any(Set),
    );
  });
});

describe("Execute-time file race safety", () => {
  it("absorbs an If-Match upload race when remote already has the same content", async () => {
    const local: LocalFileEntry = {
      path: "note.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const remoteBeforeRace: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 1,
      eTag: "etag-old",
      cTag: "",
    };
    const state = makeActiveV2State(
      [remoteBeforeRace],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { upsertPendingConflicts },
    );
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: local.size,
          mtime: 2,
          eTag: "etag-remote",
          downloadUrl: "https://download.example/note.md",
          sha256Hash: local.hash,
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag as never,
    );

    const result = await executor.run("manual", {});

    expect(diag.error).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      { path: local.path, hash: local.hash, size: local.size, eTag: "etag-remote" },
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        sha256Hash: local.hash,
        eTag: "etag-remote",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      expect.any(ArrayBuffer),
      undefined,
      "etag-old",
      "remote-id",
    );
  });

  it("uses one version-bound readback when an If-Match upload race only exposes QuickXor", async () => {
    const content = new TextEncoder().encode("same bytes from another client");
    const hash = await sha256Hex(content.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-only.md",
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-only.md",
      quickXorHash: "remote-quickxor",
    });
    const downloadFile = vi.fn().mockResolvedValue(content.buffer);
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
        quickXorHash: "old-quickxor",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content.buffer),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(addPendingConflict).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      "https://download.example/quickxor-only.md",
      "remote-id",
      local.size,
    );
    expect(getFileMetadata).toHaveBeenCalledTimes(2);
    expect(state.baseSnapshot).toEqual([
      { path: local.path, hash, size: local.size, eTag: "etag-remote" },
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-remote",
        quickXorHash: "remote-quickxor",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps both versions when a QuickXor-only upload race reads back different content", async () => {
    const localContent = new TextEncoder().encode("local-race-version");
    const remoteContent = new TextEncoder().encode("other-race-version");
    const localHash = await sha256Hex(localContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-different.md",
      size: localContent.byteLength,
      mtime: 1,
      hash: localHash,
      quickXorHash: "same-quickxor",
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-different.md",
      quickXorHash: "same-quickxor",
    });
    const downloadFile = vi.fn().mockResolvedValue(remoteContent.buffer);
    const commonHash = "00".repeat(32);
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
      }],
      [{
        path: local.path,
        hash: commonHash,
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(localContent.buffer),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      conflicts: 1,
      errors: 0,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledOnce();
    // A byte mismatch is already conclusive. Only the initial fresh metadata
    // read is needed; a second version check is reserved for equality claims.
    expect(getFileMetadata).toHaveBeenCalledOnce();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      local: expect.objectContaining({ hash: localHash }),
      remote: expect.objectContaining({
        driveId: "remote-id",
        eTag: "etag-remote",
        quickXorHash: "same-quickxor",
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(remoteHash).not.toBe(localHash);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "remote-id",
        eTag: "etag-remote",
      }),
    ]);
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash: commonHash,
      size: local.size,
      eTag: "etag-old",
    }]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps the upload race pending when the QuickXor-only readback is unavailable", async () => {
    const content = new TextEncoder().encode("local version");
    const hash = await sha256Hex(content.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-readback-failed.md",
      size: content.byteLength,
      mtime: 1,
      hash,
      quickXorHash: "same-quickxor",
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-readback-failed.md",
      quickXorHash: "same-quickxor",
    });
    const downloadFile = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
        ),
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content.buffer),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag as never,
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(getFileMetadata).toHaveBeenCalledTimes(1);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      local,
      remote: expect.objectContaining({
        driveId: "remote-id",
        eTag: "etag-remote",
        quickXorHash: "same-quickxor",
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(diag.warn).toHaveBeenCalledWith(
      "execute",
      `upload race content read-back failed — ${local.path}`,
      expect.any(Error),
    );
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        hash: "00".repeat(32),
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("does not re-upload when a same-content race commits remote identity before the base write fails", async () => {
    const local: LocalFileEntry = {
      path: "note.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
    );
    const commitBase = state.upsertBaseEntries.bind(state);
    let failBaseOnce = true;
    state.upsertBaseEntries = vi.fn(async (entries) => {
      if (failBaseOnce) {
        failBaseOnce = false;
        throw new Error("base commit interrupted");
      }
      return await commitBase(entries);
    });
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.PreconditionFailed,
        "etag changed",
        412,
      ),
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: local.size,
          mtime: 2,
          eTag: "etag-remote",
          downloadUrl: "https://download.example/note.md",
          sha256Hash: local.hash,
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const interrupted = await executor.run("manual", {});

    expect(interrupted.errors).toBe(1);
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        eTag: "etag-remote",
        sha256Hash: local.hash,
      }),
    ]);
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);

    const recovered = await executor.run("manual", {});

    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash: local.hash,
      size: local.size,
      eTag: "etag-remote",
    }]);
  });

  it("queues a pending conflict when a local file changes again before download writes", async () => {
    const scannedContent = new TextEncoder().encode("scanned");
    const localNowContent = new TextEncoder().encode("local-now");
    const remoteContent = new TextEncoder().encode("remote-now");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const localNowHash = await sha256Hex(localNowContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const local: LocalFileEntry = {
      path: "note.md",
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/note.md",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "",
      sha256Hash: remoteHash,
    };
    const state = makeActiveV2State(
      [remote],
      [{
        path: local.path,
        hash: scannedHash,
        size: scannedContent.byteLength,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(remoteContent.buffer),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(localNowContent.buffer),
            stat: vi.fn().mockResolvedValue({ mtime: 9, size: localNowContent.byteLength }),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.errors).toBe(0);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      reason: "reason.bothSidesModified",
      local: expect.objectContaining({
        hash: localNowHash,
        size: localNowContent.byteLength,
        mtime: 9,
      }),
      remote: expect.objectContaining({
        eTag: "etag-remote",
        sha256Hash: remoteHash,
      }),
    }));
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        hash: scannedHash,
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps a local edit that lands after the remote payload downloads but before commit", async () => {
    const scannedContent = new TextEncoder().encode("common-before-download");
    const localRaceContent = new TextEncoder().encode("local-edit-during-download");
    const remoteContent = new TextEncoder().encode("remote-version-to-download");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const localRaceHash = await sha256Hex(localRaceContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const path = "download-local-race.md";
    const scanned: LocalFileEntry = {
      path,
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const localAfterDownload: LocalFileEntry = {
      path,
      size: localRaceContent.byteLength,
      mtime: 9,
      hash: localRaceHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/download-local-race.md",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: remoteHash,
    };
    const inspectFile = vi.fn()
      .mockResolvedValueOnce({ status: "present", entry: scanned })
      .mockResolvedValueOnce({ status: "present", entry: localAfterDownload });
    const downloadFile = vi.fn().mockResolvedValue(remoteContent.buffer);
    const writeBinary = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{
        path,
        hash: scannedHash,
        size: scanned.size,
        eTag: "etag-common",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [scanned],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      conflicts: 1,
      errors: 0,
    });
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(inspectFile).toHaveBeenCalledTimes(2);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path,
      local: localAfterDownload,
      remote: expect.objectContaining({
        driveId: remote.driveId,
        eTag: remote.eTag,
        sha256Hash: remoteHash,
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(state.baseSnapshot).toEqual([{
      path,
      hash: scannedHash,
      size: scanned.size,
      eTag: "etag-common",
    }]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("reuses one bounded fallback download when a raced local file already equals remote", async () => {
    const scannedContent = new TextEncoder().encode("scanned");
    const currentContent = new TextEncoder().encode("same-now");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const currentHash = await sha256Hex(currentContent.buffer);
    const path = "same-after-race.md";
    const scanned: LocalFileEntry = {
      path,
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      downloadUrl: "https://download.example/same-after-race.md",
      size: currentContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "",
    };
    const downloadFile = vi.fn().mockResolvedValue(currentContent.buffer);
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{
        path,
        hash: scannedHash,
        size: scanned.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [scanned],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: { ...scanned, hash: currentHash, size: currentContent.byteLength, mtime: 9 },
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(addPendingConflict).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([{
      path,
      hash: currentHash,
      size: currentContent.byteLength,
      eTag: remote.eTag,
    }]);
  });

  it("queues a pending conflict when remote changes before DeleteRemote executes", async () => {
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const deleteItem = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const remoteBeforeRace: RemoteFileEntry = {
      path: "deleted.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 10,
      mtime: 1,
      eTag: "etag-old",
      cTag: "",
    };
    const state = makeActiveV2State(
      [remoteBeforeRace],
      [{
        path: "deleted.md",
        hash: "aa".repeat(32),
        size: 10,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        deleteItem,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: 12,
          mtime: 7,
          eTag: "etag-new",
          downloadUrl: "https://download.example/deleted.md",
          sha256Hash: "bb".repeat(32),
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.deleted).toBe(0);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: "deleted.md",
      remote: {
        path: "deleted.md",
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        downloadUrl: "https://download.example/deleted.md",
        size: 12,
        mtime: 7,
        eTag: "etag-new",
        cTag: "",
        sha256Hash: "bb".repeat(32),
      },
      reason: "reason.localDeletedRemoteModified",
      decisionToken: expect.objectContaining({
        version: 1,
        ancestorHash: "aa".repeat(32),
        remote: { exists: true, driveId: "remote-id", eTag: "etag-new" },
      }),
    }));
    expect(state.remoteSnapshot).toEqual([{
      path: "deleted.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/deleted.md",
      size: 12,
      mtime: 7,
      eTag: "etag-new",
      cTag: "",
      sha256Hash: "bb".repeat(32),
    }]);
    expect(state.baseSnapshot).toEqual([{
      path: "deleted.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-old",
    }]);
    expect(state.mutationLedger).toEqual([]);
    expect(deleteItem).toHaveBeenCalledWith(
      "testVault",
      "deleted.md",
      "etag-old",
      "remote-id",
    );
  });
});

describe("Bounded small-file upload concurrency", () => {
  it("checkpoints each independent small-upload wave after every receipt is durable", async () => {
    const smallContent = new ArrayBuffer(8);
    const smallHash = await sha256Hex(smallContent);
    const largeContent = new Uint8Array(9 * 1024 * 1024).fill(1).buffer;
    const largeHash = await sha256Hex(largeContent);
    let activeUploads = 0;
    let peakUploads = 0;
    const events: string[] = [];
    const progressStore = new SyncProgressStore();
    const uploadFile = vi.fn().mockImplementation(async (
      _vault: string,
      path: string,
      _content: ArrayBuffer,
      onProgress?: (uploadedBytes: number, totalBytes: number) => void,
    ) => {
      activeUploads++;
      peakUploads = Math.max(peakUploads, activeUploads);
      events.push(`start:${path}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (path === "large.bin") onProgress?.(largeContent.byteLength, largeContent.byteLength);
      events.push(`end:${path}`);
      activeUploads--;
      return {
        id: `id:${path}`,
        eTag: `etag:${path}`,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const smallEntries = Array.from({ length: 8 }, (_, index): LocalFileEntry => ({
      path: `small-${index}.md`,
      hash: smallHash,
      size: smallContent.byteLength,
      mtime: index,
      binary: false,
    }));
    const largeEntry: LocalFileEntry = {
      path: "large.bin",
      hash: largeHash,
      size: largeContent.byteLength,
      mtime: 99,
      binary: true,
    };
    const localEntries = [...smallEntries, largeEntry];
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn(async (path: string) =>
              path === largeEntry.path ? largeContent : smallContent),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localEntries.find((candidate) => candidate.path === path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      progressStore,
    );

    const result = await executor.run("manual", {});

    expect(result.uploaded).toBe(9);
    expect(result.metrics?.fileTransfers.upload).toMatchObject({
      started: 9,
      succeeded: 9,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      logicalBytes: largeContent.byteLength + smallContent.byteLength * smallEntries.length,
      peakConcurrency: 3,
    });
    expect(result.metrics?.mutationPersistence).toMatchObject({
      intentWrites: 9,
      receiptWrites: 9,
      checkpointOperations: 9,
      checkpointCommits: 5,
      checkpointFailures: 0,
    });
    expect(
      result.metrics?.mutationPersistence.stagesMs.checkpointTotal,
    ).toBeGreaterThanOrEqual(0);
    expect(peakUploads).toBe(3);
    expect(events.indexOf("start:large.bin")).toBeGreaterThan(events.indexOf("end:small-7.md"));
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toHaveLength(localEntries.length);
    expect(state.baseSnapshot).toHaveLength(localEntries.length);
  });

  it("keeps every durable receipt when a shared upload checkpoint cannot commit", async () => {
    const content = new ArrayBuffer(8);
    const hash = await sha256Hex(content);
    const localEntries = ["first.md", "second.md"].map(
      (path, index): LocalFileEntry => ({
        path,
        hash,
        size: content.byteLength,
        mtime: index + 1,
        binary: false,
      }),
    );
    const uploadFile = vi.fn().mockImplementation(async (
      _vault: string,
      path: string,
    ) => ({
      id: `id:${path}`,
      eTag: `etag:${path}`,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    }));
    const state = makeActiveV2State([], []);
    const commitMutationCheckpoints = vi.fn().mockRejectedValue(
      new Error("shared checkpoint failed"),
    );
    state.commitMutationCheckpoints = commitMutationCheckpoints;
    const onFileComplete = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localEntries.find((candidate) => candidate.path === path);
          return entry ? { status: "present", entry } : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", { onFileComplete });

    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(2);
    expect(result.errors).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(commitMutationCheckpoints).toHaveBeenCalledTimes(2);
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(2);
    expect(state.mutationLedger.every((record) => record.receipt !== null)).toBe(true);
    expect(result.metrics?.mutationPersistence).toMatchObject({
      intentWrites: 2,
      receiptWrites: 2,
      checkpointOperations: 0,
      checkpointCommits: 0,
      checkpointFailures: 2,
    });
    expect(onFileComplete).toHaveBeenCalledTimes(2);
    expect(onFileComplete.mock.calls.every((call) => call[2] === false)).toBe(true);
  });

  it("serializes concurrent state saves", async () => {
    let activeSaves = 0;
    let peakSaves = 0;
    let saveQueue: Promise<void> = Promise.resolve();
    const plugin = {
      loadData: vi.fn().mockResolvedValue({}),
      saveData: vi.fn().mockImplementation(async () => {
        activeSaves++;
        peakSaves = Math.max(peakSaves, activeSaves);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeSaves--;
      }),
      updatePluginData: vi.fn(async (mutator: (data: Record<string, unknown>) => void) => {
        const task = saveQueue.then(async () => {
          const d = (await plugin.loadData()) ?? {};
          mutator(d);
          await plugin.saveData(d);
        });
        saveQueue = task.catch(() => undefined);
        return task;
      }),
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockRejectedValue(new Error("missing")),
          },
        },
      },
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    };
    const state = new StateManager(plugin);
    await state.load();

    await Promise.all(["a.md", "b.md", "c.md"].map((path) =>
      state.addPendingConflict({ type: SyncActionType.Conflict, path })
    ));

    expect(peakSaves).toBe(1);
    expect(state.pendingConflicts.map((entry) => entry.path).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });
});

describe("Conservative desktop small-file download concurrency", () => {
  function makeDownloadLocalStore(onWrite?: () => Promise<void>) {
    const files = new Map<string, ArrayBuffer>();
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => files.has(path)),
      stat: vi.fn(async (path: string) => {
        const content = files.get(path);
        return content
          ? { size: content.byteLength, mtime: 1 }
          : null;
      }),
      readBinary: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing ${path}`);
        return content.slice(0);
      }),
      writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => {
        await onWrite?.();
        files.set(path, content.slice(0));
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const content = files.get(from);
        if (!content) throw new Error(`missing ${from}`);
        files.set(to, content);
        files.delete(from);
      }),
    });
    const inspectFile = vi.fn(async (path: string) => {
      const content = files.get(path);
      if (!content) return { status: "missing" as const };
      return {
        status: "present" as const,
        entry: {
          path,
          size: content.byteLength,
          mtime: 1,
          hash: await sha256Hex(content),
          binary: true,
        },
      };
    });
    return { adapter, files, inspectFile };
  }

  it("reports the downloaded version size instead of the overwritten local size", async () => {
    const path = "changed-remotely.md";
    const localBytes = new Uint8Array([1, 2, 3]).buffer;
    const remoteBytes = new Uint8Array([4, 5, 6, 7, 8]).buffer;
    const localHash = await sha256Hex(localBytes);
    const remoteHash = await sha256Hex(remoteBytes);
    const local: LocalFileEntry = {
      path,
      size: localBytes.byteLength,
      mtime: 1,
      hash: localHash,
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-changed",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteBytes.byteLength,
      mtime: 2,
      eTag: "etag-new",
      cTag: "ctag-new",
      sha256Hash: remoteHash,
    };
    const base: BaseFileEntry = {
      path,
      size: localBytes.byteLength,
      hash: localHash,
      eTag: "etag-old",
    };
    const localStore = makeDownloadLocalStore();
    localStore.files.set(path, localBytes.slice(0));
    const state = makeActiveV2State([remote], [base]);
    const onFileComplete = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(remoteBytes.slice(0)),
        hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
      }),
      {
        vault: {
          adapter: localStore.adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        inspectFile: localStore.inspectFile,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", { onFileComplete });

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.metrics?.fileTransfers.download.logicalBytes).toBe(remoteBytes.byteLength);
    expect(onFileComplete).toHaveBeenCalledWith(
      path,
      SyncActionType.Download,
      true,
      undefined,
      remoteBytes.byteLength,
    );
    expect(state.baseSnapshot).toContainEqual(expect.objectContaining({
      path,
      size: remoteBytes.byteLength,
      hash: remoteHash,
      eTag: remote.eTag,
    }));
    expect(await sha256Hex(localStore.files.get(path)!)).toBe(remoteHash);
  });

  it("overlaps only network prefetch while local writes stay serial", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const bytes = new Uint8Array(256 * 1024);
      bytes.fill(7);
      const buffer = bytes.buffer;
      const hash = await sha256Hex(buffer);
      let activeDownloads = 0;
      let peakDownloads = 0;
      let activeWrites = 0;
      let peakWrites = 0;
      const downloadFile = vi.fn().mockImplementation(async () => {
        activeDownloads++;
        peakDownloads = Math.max(peakDownloads, activeDownloads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDownloads--;
        return buffer.slice(0);
      });
      const writeBinary = vi.fn().mockImplementation(async () => {
        activeWrites++;
        peakWrites = Math.max(peakWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeWrites--;
      });
      const remoteEntries = Array.from({ length: 9 }, (_, index): RemoteFileEntry => ({
        path: `download-${index}.bin`,
        driveId: `remote-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
        sha256Hash: hash,
      }));
      const localStore = makeDownloadLocalStore(writeBinary);
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // The policy may conservatively remain at 2 when real test-clock
      // throughput drops. Deterministic 1 -> 2 -> 3 promotion is covered by
      // download-concurrency-policy.test.ts; this integration contract only
      // requires actual overlap, the hard cap, and serial local commits.
      expect(peakDownloads).toBeGreaterThanOrEqual(2);
      expect(peakDownloads).toBeLessThanOrEqual(3);
      expect(peakWrites).toBe(1);
      expect(result.metrics?.fileTransfers.download).toMatchObject({
        started: remoteEntries.length,
        succeeded: remoteEntries.length,
        failed: 0,
        peakConcurrency: peakDownloads,
      });
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("batches missing download URLs and hashless version checks without weakening verification", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const buffer = new Uint8Array(256 * 1024).fill(9).buffer;
      const hash = await sha256Hex(buffer);
      const remoteEntries = Array.from({ length: 6 }, (_, index): RemoteFileEntry => ({
        path: `metadata-batch-${index}.bin`,
        driveId: `metadata-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `metadata-etag-${index}`,
        cTag: `metadata-ctag-${index}`,
        ...(index < 2 ? { sha256Hash: hash } : {}),
      }));
      const remoteById = new Map(remoteEntries.map((entry) => [entry.driveId, entry]));
      const getDriveItemMetadataByIds = vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => {
          const remote = remoteById.get(id)!;
          return [id, {
            id,
            name: remote.path,
            size: remote.size,
            eTag: remote.eTag,
            cTag: remote.cTag,
            file: {},
            parentReference: { id: remote.parentId },
            "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
          }];
        })),
      );
      const downloadFile = vi.fn().mockResolvedValue(buffer.slice(0));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          getDriveItemMetadataByIds,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      expect(getDriveItemMetadataByIds).toHaveBeenCalledTimes(4);
      expect(getDriveItemMetadataByIds.mock.calls.map((call) => call[1])).toEqual([
        "downloadUrlRefresh",
        "downloadVersionVerify",
        "downloadUrlRefresh",
        "downloadVersionVerify",
      ]);
      expect(downloadFile.mock.calls.slice(2).every((call) =>
        typeof call[2] === "string" && call[2].startsWith("https://download.example/"),
      )).toBe(true);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("returns to serial after the download path reports degradation", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const buffer = new Uint8Array(1024 * 1024).fill(3).buffer;
      const hash = await sha256Hex(buffer);
      let active = 0;
      let peak = 0;
      const batchHealth = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const downloadFile = vi.fn().mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active--;
        return buffer.slice(0);
      });
      const remoteEntries = Array.from({ length: 7 }, (_, index): RemoteFileEntry => ({
        path: `degraded-${index}.bin`,
        driveId: `degraded-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `degraded-etag-${index}`,
        cTag: "",
        sha256Hash: hash,
      }));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: batchHealth,
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      expect(peak).toBe(2);
      expect(batchHealth).toHaveBeenCalledTimes(6);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });
});

describe("Pending conflict cleanup", () => {
  it("clears stale pending conflicts when the current healthy plan has none", async () => {
    const pendingConflicts: SyncPlanItem[] = [
      {
        type: SyncActionType.Conflict,
        path: "stale.md",
        reason: "reason.bothSidesModified",
      },
    ];
    const prunePendingConflicts = vi.fn(async (activePaths: Iterable<string>) => {
      const active = new Set(activePaths);
      pendingConflicts.splice(
        0,
        pendingConflicts.length,
        ...pendingConflicts.filter((item) => active.has(item.path)),
      );
    });
    const state = makeActiveV2State([], [], {
      pendingConflicts,
      async prunePendingConflicts(activePaths: Iterable<string>) {
        await prunePendingConflicts(activePaths);
      },
    });

    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(0);
    expect(prunePendingConflicts).toHaveBeenCalledWith([]);
    expect(pendingConflicts).toHaveLength(0);
  });

  it("keeps pending conflicts when the current scan is unhealthy", async () => {
    const pendingConflicts: SyncPlanItem[] = [
      {
        type: SyncActionType.Conflict,
        path: "keep.md",
        reason: "reason.bothSidesModified",
      },
    ];
    const prunePendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([], [], {
      pendingConflicts,
      prunePendingConflicts,
    });
    const getDelta = vi.fn();

    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: ["keep.md"],
          skippedCount: 0,
          complete: false,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.message).toBe("result.scanIncomplete");
    expect(getDelta).not.toHaveBeenCalled();
    expect(prunePendingConflicts).not.toHaveBeenCalled();
    expect(pendingConflicts).toHaveLength(1);
  });
});

describe("Download plan preserves the scanned local version", () => {
  it("keeps the local CAS expectation when only the remote version changed", () => {
    const path = "same-line-append.md";
    const base: BaseFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 280,
      eTag: "etag-v5",
    };
    const local: LocalFileEntry = {
      path,
      hash: base.hash,
      size: base.size,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-same-line-append",
      size: 290,
      mtime: 2,
      eTag: "etag-v6",
      cTag: "ctag-v6",
    };

    const plan = generateFileDecisionPlanV2({
      localEntries: [local],
      remoteEntries: [remote],
      baseEntries: [base],
      skippedLarge: [],
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path,
        local,
        remote,
      }),
    ]);
  });
});

// ---- Large file boundary: base file growing beyond 50MB ----
// Tests that files which outgrow the size limit do NOT trigger
// false deletions, baseline corruption, or silent sync loss.

describe("Large file boundary — base file exceeds 50MB", () => {
  const engine = new V2FilePlanTestHarness();
  const protectedConfigPaths = [
    ".obsidian/app.json",
    ".obsidian/appearance.json",
    ".obsidian/hotkeys.json",
    ".obsidian/core-plugins.json",
    ".obsidian/community-plugins.json",
  ] as const;

  function baseEntry(path: string, overrides: Partial<BaseFileEntry> = {}): BaseFileEntry {
    return { path, hash: "bb".repeat(32), size: 10000, eTag: "old-etag", ...overrides };
  }

  function localEntry(path: string, overrides: Partial<LocalFileEntry> = {}): LocalFileEntry {
    return { path, size: 10000, mtime: 1, hash: "aa".repeat(32), binary: false, ...overrides };
  }

  function remoteEntry(path: string, overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
    return { path, driveId: `id-${path}`, size: 10000, mtime: 1, eTag: "old-etag", cTag: "ctag", ...overrides };
  }

  it("file in base+remote, grew >50MB → SkipLargeFile, NOT DeleteRemote", () => {
    // File was synced (in base + remote), but now too large to scan.
    // The engine must NOT generate DeleteRemote — the file still exists locally.
    const plan = engine.buildFilePlan(
      [],                          // localEntries — empty because file was skipped
      [remoteEntry("big.mp4")],    // remote still has it
      [baseEntry("big.mp4")],      // base still has it
      ["big.mp4"],                 // skippedLarge
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("adds skipped-large items without rescanning the growing plan", () => {
    const skippedLarge = Array.from({ length: 100 }, (_, index) => `large-${index}.bin`);
    const some = vi.spyOn(Array.prototype, "some");

    try {
      const plan = engine.buildFilePlan([], [], [], skippedLarge);
      expect(plan.items).toHaveLength(skippedLarge.length);
      expect(some).not.toHaveBeenCalled();
    } finally {
      some.mockRestore();
    }
  });

  it("file in base only (not remote), grew >50MB → SkipLargeFile, NOT a delete", () => {
    // Local-only file outgrew limit. Should just be skipped, not trigger any delete.
    const plan = engine.buildFilePlan(
      [],
      [],
      [baseEntry("big.mp4")],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("file in base+remote, remote also modified, grew >50MB → SkipLargeFile, not Conflict or DeleteRemote", () => {
    // Worst case: both sides changed but we can't read local. Safest: skip, let user handle.
    const plan = engine.buildFilePlan(
      [],
      [remoteEntry("big.mp4", { eTag: "new-etag", size: 20000 })],
      [baseEntry("big.mp4")],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("normal file (<50MB) in base, genuinely deleted locally → still DeleteRemote (regression)", () => {
    // This is the normal case: file was small, user deleted it. Should still work.
    const plan = engine.buildFilePlan(
      [],
      [remoteEntry("deleted.md")],
      [baseEntry("deleted.md")],
      [],  // NOT in skippedLarge — genuinely deleted
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.DeleteRemote, path: "deleted.md" },
    ]);
  });

  for (const path of protectedConfigPaths) {
    it(`protected config ${path} missing remotely is recreated instead of becoming a delete decision`, () => {
      const plan = engine.buildFilePlan(
        [localEntry(path, { hash: "changed".repeat(9) + "c", size: 851 })],
        [],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Upload,
        path,
      }));
      expect(plan.items.some((item) =>
        (item.type === SyncActionType.ConfirmLocalDelete || item.type === SyncActionType.Conflict)
          && item.path === path,
      )).toBe(false);
    });

    it(`protected config ${path} missing locally is restored instead of becoming a delete decision`, () => {
      const plan = engine.buildFilePlan(
        [],
        [remoteEntry(path, { size: 851, eTag: "etag-new" })],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Download,
        path,
      }));
      expect(plan.items.some((item) =>
        (item.type === SyncActionType.DeleteRemote || item.type === SyncActionType.Conflict)
          && item.path === path,
      )).toBe(false);
    });
  }

  it("file in base, not scanned, not in skippedLarge, not in remote → no action (deleted both sides)", () => {
    // Edge case: file was in base but now missing from local, remote, AND skippedLarge.
    // Should be treated as deleted-on-both-sides → no action.
    const plan = engine.buildFilePlan(
      [],
      [],
      [baseEntry("gone.md")],
      [],
    );

    expect(plan.items).toHaveLength(0);
  });

  it("mixed: one normal delete + one oversized skip in same plan", () => {
    const plan = engine.buildFilePlan(
      [],
      [
        remoteEntry("deleted.md"),
        remoteEntry("big.mp4"),
      ],
      [
        baseEntry("deleted.md"),
        baseEntry("big.mp4"),
      ],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual({ type: SyncActionType.DeleteRemote, path: "deleted.md" });
    expect(actions).toContainEqual({ type: SyncActionType.SkipLargeFile, path: "big.mp4" });
    expect(actions).toHaveLength(2);
  });
});

// ---- Rename detection via content hash matching ----

describe("Rename detection — content hash matching", () => {
  const engine = new V2FilePlanTestHarness();

  function localEntry(path: string, hash: string, size = 100): LocalFileEntry {
    return { path, hash, size, mtime: Date.now(), binary: false };
  }

  function remoteEntry(path: string): RemoteFileEntry {
    return { path, driveId: `id-${path}`, size: 100, mtime: Date.now(), eTag: "etag-1", cTag: "ctag-1" };
  }

  function baseEntry(path: string, hash = "abc123", eTag = "etag-1"): BaseFileEntry {
    return { path, hash, size: 100, eTag };
  }

  it("same-directory rename produces RenameRemote, not Upload + DeleteRemote", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "abc123")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "abc123")],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path, renameFrom: i.renameFrom }));
    expect(actions).toContainEqual({ type: SyncActionType.RenameRemote, path: "new.md", renameFrom: "old.md" });
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }));
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
  });

  it("Preflight P0 — remote modification prevents local rename detection", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "abc123")],
      [{ ...remoteEntry("old.md"), eTag: "etag-2" }],
      [baseEntry("old.md", "abc123", "etag-1")],
      [],
    );

    expect(plan.items).not.toContainEqual(
      expect.objectContaining({ type: SyncActionType.RenameRemote, path: "new.md", renameFrom: "old.md" }),
    );
    expect(plan.items).toContainEqual(
      expect.objectContaining({ type: SyncActionType.Conflict, path: "old.md" }),
    );
    expect(plan.items).toContainEqual(
      expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }),
    );
  });

  it("cross-directory rename preserves the old remote object when identity move is unavailable", () => {
    const plan = engine.buildFilePlan(
      [localEntry("sub/new.md", "abc123")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "abc123")],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "sub/new.md" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Conflict, path: "old.md" }));
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
    expect(actions.filter((a) => a.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("empty file rename is NOT matched (0-byte skipped)", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const plan = engine.buildFilePlan(
      [localEntry("new.md", emptyHash, 0)],
      [remoteEntry("old.md")],
      [{ path: "old.md", hash: emptyHash, size: 0, eTag: "etag-1" }],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
    expect(actions.filter((a) => a.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("ambiguous same-hash copies preserve the old remote object", () => {
    const hash = "abc123";
    const plan = engine.buildFilePlan(
      [localEntry("copy1.md", hash), localEntry("copy2.md", hash)],
      [remoteEntry("old.md")],
      [baseEntry("old.md", hash)],
      [],
    );

    const uploads = plan.items.filter((i) => i.type === SyncActionType.Upload);
    expect(uploads).toHaveLength(2);
    expect(plan.items.some((i) => i.type === SyncActionType.Conflict && i.path === "old.md")).toBe(true);
    expect(plan.items.some((i) => i.type === SyncActionType.DeleteRemote && i.path === "old.md")).toBe(false);
    expect(plan.items.filter((i) => i.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("no false match when old file hash differs from new file", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "different-hash")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "old-hash")],
      [],
    );

    expect(plan.items.some((i) => i.type === SyncActionType.Upload && i.path === "new.md")).toBe(true);
    expect(plan.items.some((i) => i.type === SyncActionType.DeleteRemote && i.path === "old.md")).toBe(true);
    expect(plan.items.filter((i) => i.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });
});

describe("Conflict resolution actions report standalone transfer progress", () => {
  async function waitUntil(assertion: () => void, attempts = 20): Promise<void> {
    let lastError: unknown;
    for (let index = 0; index < attempts; index++) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    throw lastError;
  }

  function makeProgressAwareExecutor(options: {
    downloadFile?: ReturnType<typeof vi.fn>;
    uploadFile?: ReturnType<typeof vi.fn>;
    pendingConflicts?: SyncPlanItem[];
    pendingRemoteDeletes?: SyncPlanItem[];
    adapterOverrides?: Record<string, unknown>;
    scanFile?: ReturnType<typeof vi.fn>;
    inspectFile?: ReturnType<typeof vi.fn>;
    stateOverrides?: Record<string, unknown>;
    fileManager?: Record<string, unknown>;
    vaultFile?: unknown;
    getFileMetadata?: ReturnType<typeof vi.fn>;
    initVaultScope?: ReturnType<typeof vi.fn>;
    preserveMissingDecisionTokens?: boolean;
    onProgressUpdate?: () => void;
    progressStore?: SyncProgressStore;
    diag?: DiagnosticLogger;
    noticeCenter?: EasySyncNoticeCenter;
    shouldSyncPath?: ReturnType<typeof vi.fn>;
  }): SyncExecutor {
    const progressStore = options.progressStore ?? new SyncProgressStore();
    const addToken = (item: SyncPlanItem): SyncPlanItem => {
      const completeItem = item.remote && !item.remote.parentId
        ? {
            ...item,
            remote: {
              ...item.remote,
              parentId: item.path.includes("/")
                ? "reviewed-parent-id"
                : TEST_SYNC_SCOPE.filesRootId,
            },
          }
        : item;
      return options.preserveMissingDecisionTokens
      ? completeItem
      : {
          ...completeItem,
          decisionToken: completeItem.decisionToken ?? {
            version: 1,
            vaultName: "testVault",
            accountId: "account-test",
            scope: { ...TEST_SYNC_SCOPE, accountId: "account-test" },
            local: completeItem.local
              ? { exists: true, hash: completeItem.local.hash, size: completeItem.local.size }
              : { exists: false },
            remote: completeItem.remote
              ? { exists: true, driveId: completeItem.remote.driveId, eTag: completeItem.remote.eTag }
              : { exists: false },
            ancestorHash: null,
          },
        };
    };
    const pendingConflicts = (options.pendingConflicts ?? []).map(addToken);
    const pendingRemoteDeletes = (options.pendingRemoteDeletes ?? []).map(addToken);
    const reviewedRemoteByPath = new Map(
      [...pendingConflicts, ...pendingRemoteDeletes]
        .flatMap((item) => item.remote ? [[item.remote.path, item.remote] as const] : []),
    );
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      boundAccountId: "account-test",
      pendingConflicts,
      pendingRemoteDeletes,
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn().mockResolvedValue(undefined),
      removePendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
      cacheBaseContent: vi.fn(),
      ...options.stateOverrides,
    } as unknown as StateManager;

    return new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile,
        uploadFile: options.uploadFile,
        ...(options.initVaultScope ? { initVaultScope: options.initVaultScope } : {}),
        getFileMetadata: options.getFileMetadata ?? vi.fn().mockImplementation(async (_vault: string, path: string) => {
          const reviewedRemote = reviewedRemoteByPath.get(path);
          return reviewedRemote ? {
              driveId: reviewedRemote.driveId,
              size: reviewedRemote.size,
              mtime: reviewedRemote.mtime,
              eTag: reviewedRemote.eTag,
              downloadUrl: reviewedRemote.downloadUrl,
              sha256Hash: reviewedRemote.sha256Hash,
            }
            : null;
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(options.adapterOverrides),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getFileByPath: vi.fn().mockReturnValue(options.vaultFile ?? null),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: options.scanFile ?? vi.fn().mockResolvedValue(null),
        shouldSyncPath: options.shouldSyncPath ?? vi.fn().mockReturnValue(true),
        ...(options.inspectFile ? { inspectFile: options.inspectFile } : {}),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
      undefined,
      progressStore,
      options.diag,
      options.fileManager as never,
      options.onProgressUpdate,
      undefined,
      options.noticeCenter,
    );
  }

  function makeNoticeRecorder(): {
    center: EasySyncNoticeCenter;
    messages: string[];
  } {
    const messages: string[] = [];
    const center = new EasySyncNoticeCenter((message) => {
      messages.push(String(message));
      return {
        setMessage(next) {
          messages.push(String(next));
        },
        hide: vi.fn(),
      };
    });
    return { center, messages };
  }

  it("keepRemote feeds byte progress into the shared progress store", async () => {
    const progressStore = new SyncProgressStore();
    const snapshots: Array<{
      phase: string;
      currentFile: string;
      currentActionType?: SyncActionType;
      currentItemBytes: number;
      currentItemTotalBytes: number;
    }> = [];
    const remote = {
      path: "attachments/audio.m4a",
      driveId: "drive-1",
      downloadUrl: "https://example.invalid/download",
      size: 10,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
    } as RemoteFileEntry;
    const executor = makeProgressAwareExecutor({
      progressStore,
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: remote.path,
        remote,
        local: {
          path: remote.path,
          hash: "aa".repeat(32),
          size: 10,
          mtime: 1,
          binary: true,
        },
      }],
      adapterOverrides: {
        stat: vi.fn().mockResolvedValue({ size: 10, mtime: 1 }),
      },
      downloadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, _downloadUrl?: string, _driveId?: string, fileSize = 0, onProgress?: (downloaded: number, total: number) => void) => {
          onProgress?.(4, fileSize);
          onProgress?.(fileSize, fileSize);
          return new Uint8Array(fileSize).fill(7).buffer;
        },
      ),
      onProgressUpdate: () => {
        snapshots.push({
          phase: progressStore.state.phase,
          currentFile: progressStore.state.currentFile,
          currentActionType: progressStore.state.currentActionType,
          currentItemBytes: progressStore.state.currentItemBytes,
          currentItemTotalBytes: progressStore.state.currentItemTotalBytes,
        });
      },
    });

    await executor.resolveConflictKeepRemote(remote.path);

    expect(snapshots.some((snapshot) =>
      snapshot.phase === "executing"
      && snapshot.currentFile === remote.path
      && snapshot.currentActionType === SyncActionType.Download,
    )).toBe(true);
    await waitUntil(() => {
      expect(snapshots.some((snapshot) =>
        snapshot.currentItemBytes === 4 && snapshot.currentItemTotalBytes === 10,
      )).toBe(true);
      expect(progressStore.state.phase).toBe("done");
    });
  });

  it("reconciles an exact-content conflict without uploading or downloading again", async () => {
    const path = "same.md";
    const content = new TextEncoder().encode("same").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      size: content.byteLength,
      mtime: 1,
      eTag: "etag-same",
      cTag: "",
    };
    const reconcileIdenticalConflict = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn();
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      stateOverrides: { reconcileIdenticalConflict },
      downloadFile,
      uploadFile,
    });

    await executor.reconcileIdenticalConflict(path, {
      localHash: hash,
      localSize: content.byteLength,
      remoteHash: hash,
      remoteSize: content.byteLength,
      remoteETag: remote.eTag,
    });

    expect(reconcileIdenticalConflict).toHaveBeenCalledWith({
      path,
      hash,
      size: content.byteLength,
      eTag: remote.eTag,
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("keeps the conflict when the remote eTag changes after exact-content review", async () => {
    const path = "same-raced.md";
    const content = new TextEncoder().encode("same").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path, hash, size: content.byteLength, mtime: 1, binary: false,
    };
    const remote: RemoteFileEntry = {
      path, driveId: "remote-id", size: content.byteLength,
      mtime: 1, eTag: "etag-reviewed", cTag: "",
    };
    const reconcileIdenticalConflict = vi.fn().mockResolvedValue(undefined);
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      getFileMetadata: vi.fn().mockResolvedValue({
        ...remote,
        eTag: "etag-new",
      }),
      stateOverrides: { reconcileIdenticalConflict, addPendingConflict },
    });

    await executor.reconcileIdenticalConflict(path, {
      localHash: hash,
      localSize: content.byteLength,
      remoteHash: hash,
      remoteSize: content.byteLength,
      remoteETag: remote.eTag,
    });

    expect(reconcileIdenticalConflict).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      path,
      remote: expect.objectContaining({ eTag: "etag-new" }),
    }));
  });

  it("keepLocal feeds upload progress into the shared progress store", async () => {
    const progressStore = new SyncProgressStore();
    const snapshots: Array<{
      phase: string;
      currentFile: string;
      currentActionType?: SyncActionType;
      currentItemBytes: number;
      currentItemTotalBytes: number;
    }> = [];
    const local = {
      path: "attachments/audio.m4a",
      hash: "bb".repeat(32),
      size: 12,
      mtime: 1,
      binary: true,
    } as LocalFileEntry;
    const executor = makeProgressAwareExecutor({
      progressStore,
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: local.path,
        local,
        remote: {
          path: local.path,
          driveId: "drive-1",
          size: 12,
          mtime: 1,
          eTag: "etag-1",
          cTag: "ctag-1",
        },
      }],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array(local.size).fill(9).buffer),
      },
      uploadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, content: ArrayBuffer, onProgress?: (uploaded: number, total: number) => void) => {
          onProgress?.(5, content.byteLength);
          onProgress?.(content.byteLength, content.byteLength);
          return { id: "uploaded-id", eTag: "uploaded-etag" };
        },
      ),
      onProgressUpdate: () => {
        snapshots.push({
          phase: progressStore.state.phase,
          currentFile: progressStore.state.currentFile,
          currentActionType: progressStore.state.currentActionType,
          currentItemBytes: progressStore.state.currentItemBytes,
          currentItemTotalBytes: progressStore.state.currentItemTotalBytes,
        });
      },
    });

    await executor.resolveConflictKeepLocal(local.path);

    expect(snapshots.some((snapshot) =>
      snapshot.phase === "executing"
      && snapshot.currentFile === local.path
      && snapshot.currentActionType === SyncActionType.Upload,
    )).toBe(true);
    await waitUntil(() => {
      expect(snapshots.some((snapshot) =>
        snapshot.currentItemBytes === 5 && snapshot.currentItemTotalBytes === local.size,
      )).toBe(true);
      expect(progressStore.state.phase).toBe("done");
    });
  });

  it("abandons a proven not-applied keepRemote intent in the same side action", async () => {
    const path = "network-failed.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path, driveId: "remote-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "",
        },
      }],
      stateOverrides: { abandonMutationIntent },
      downloadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      ),
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.downloadFailed:${path}`);
    notice.center.dispose();
  });

  it("reconciles a completed side mutation before reporting a checkpoint failure", async () => {
    const path = "receipt-recovered.md";
    const content = new Uint8Array([7]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path, hash, size: content.byteLength, mtime: 1, binary: false,
    };
    const reviewedRemote = {
      path, driveId: "remote-id", size: 1, mtime: 1,
      eTag: "etag-reviewed", cTag: "", sha256Hash: "bb".repeat(32),
    } as RemoteFileEntry;
    const uploadedRemote = {
      driveId: "remote-id",
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-uploaded",
      sha256Hash: hash,
    };
    const recordMutationReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("checkpoint response lost"))
      .mockResolvedValueOnce(undefined);
    const commitMutationCheckpoint = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: reviewedRemote,
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(content) },
      getFileMetadata: vi.fn()
        .mockResolvedValueOnce(reviewedRemote)
        .mockResolvedValue(uploadedRemote),
      uploadFile: vi.fn().mockResolvedValue({
        id: uploadedRemote.driveId,
        eTag: uploadedRemote.eTag,
        size: uploadedRemote.size,
      }),
      stateOverrides: { recordMutationReceipt, commitMutationCheckpoint },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(recordMutationReceipt).toHaveBeenCalledTimes(2);
    expect(recordMutationReceipt.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      checkpoint: expect.objectContaining({
        pendingConflictRemovals: [path],
      }),
    }));
    expect(commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.keptLocal:${path}`);
    notice.center.dispose();
  });

  it("reports side-action auth expiry as auth expiry and settles a not-applied intent", async () => {
    const path = "auth-expired.md";
    const content = new Uint8Array([1]).buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path, driveId: "remote-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(content) },
      uploadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.AuthExpired, "token expired", 401),
      ),
      stateOverrides: { abandonMutationIntent },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:result.authExpired:${path}`);
    notice.center.dispose();
  });

  it.each([
    {
      name: "remote preparation",
      initVaultScope: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      ),
      stateOverrides: {},
      expectedKey: "notice.sideActionRemotePrepareFailed",
    },
    {
      name: "scope validation",
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      stateOverrides: {
        remoteScope: {
          accountId: "account-test",
          driveId: "different-drive",
          vaultFolderId: "vault-folder-id",
          filesRootId: "files-root-id",
        },
      },
      expectedKey: "notice.sideActionScopeChanged",
    },
    {
      name: "mutation recovery",
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      stateOverrides: { hasMutationLedgerCorruption: true },
      expectedKey: "notice.sideActionMutationRecoveryFailed",
    },
  ])("labels $name failures by their actual preparation phase", async ({
    initVaultScope,
    stateOverrides,
    expectedKey,
  }) => {
    const path = "phase.md";
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
      }],
      uploadFile: vi.fn(),
      initVaultScope,
      stateOverrides,
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(notice.center.activeKey).toBe(`side-action:${expectedKey}:${path}`);
    notice.center.dispose();
  });

  it("expires a protected one-sided legacy conflict instead of deleting a managed config file", async () => {
    const remove = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: ".obsidian/app.json",
        local: {
          path: ".obsidian/app.json",
          hash: "aa".repeat(32),
          size: 850,
          mtime: 1,
          binary: false,
        },
        reason: "reason.fileDeletedFromRemote",
      }],
      adapterOverrides: {
        remove,
      },
      stateOverrides: { removePendingConflict },
      initVaultScope,
    });

    await executor.resolveConflictKeepRemote(".obsidian/app.json");

    await waitUntil(() => {
      expect(executor.isSideActionQueued(".obsidian/app.json")).toBe(false);
    });

    expect(remove).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(".obsidian/app.json");
  });

  it("expires a one-sided EasySync build conflict instead of deleting the running plugin", async () => {
    const path = ".obsidian/plugins/easy-sync/main.js";
    const remove = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1_700_000,
          mtime: 1,
          binary: false,
        },
        reason: "reason.fileDeletedFromRemote",
      }],
      adapterOverrides: { remove },
      stateOverrides: { removePendingConflict },
      initVaultScope,
      shouldSyncPath: vi.fn().mockReturnValue(true),
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(remove).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
  });

  it("expires any conflict whose path left the current sync scope", async () => {
    const path = ".obsidian/plugins/example-plugin/main.js";
    const downloadFile = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1,
          mtime: 1,
          binary: false,
        },
        remote: {
          path,
          driveId: "remote-plugin-main",
          size: 1,
          mtime: 1,
          eTag: "etag-reviewed",
          cTag: "ctag-reviewed",
        },
      }],
      downloadFile,
      stateOverrides: { removePendingConflict },
      initVaultScope,
      shouldSyncPath: vi.fn().mockReturnValue(false),
    });

    await executor.resolveConflictKeepRemote(path);

    expect(initVaultScope).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
  });

  it("expires a pending config decision when its sync toggle is now off", async () => {
    const path = ".obsidian/app.json";
    const uploadFile = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      shouldSyncPath: vi.fn().mockReturnValue(false),
      stateOverrides: { removePendingConflict },
      initVaultScope,
      uploadFile,
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);

    expect(initVaultScope).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
    expect(notice.center.activeKey).toBe(`side-action:notice.configSyncDisabled:${path}`);
    notice.center.dispose();
  });

  it("keepLocal uploads the current managed config snapshot after it changed since review", async () => {
    const path = ".obsidian/app.json";
    const reviewedContent = new TextEncoder().encode('{"theme":"old"}').buffer;
    const currentContent = new TextEncoder().encode('{"theme":"current"}').buffer;
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedContent),
      size: reviewedContent.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentHash = await sha256Hex(currentContent);
    const uploadFile = vi.fn().mockResolvedValue({ id: "remote-id", eTag: "etag-new" });
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: reviewedContent.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: currentHash, size: currentContent.byteLength, mtime: 2 },
      }),
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(currentContent),
        stat: vi.fn().mockResolvedValue({ size: currentContent.byteLength, mtime: 2 }),
      },
      uploadFile,
      stateOverrides: { beginMutationIntent, recordMutationReceipt },
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      path,
      currentContent,
      expect.any(Function),
      "etag-old",
      "remote-id",
    );
    expect(beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      expectedLocal: { exists: true, hash: currentHash, size: currentContent.byteLength },
    }));
    expect(recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseUpserts: [expect.objectContaining({ path, hash: currentHash, size: currentContent.byteLength })],
      }),
    }));
  });

  it("keepRemote replaces a managed config using a fresh local CAS instead of the reviewed hash", async () => {
    const path = ".obsidian/app.json";
    const reviewedBytes = new TextEncoder().encode('{"theme":"old"}').buffer;
    const currentBytes = new TextEncoder().encode('{"theme":"current"}').buffer;
    const remoteBytes = new TextEncoder().encode('{"theme":"remote"}').buffer;
    const files = new Map<string, ArrayBuffer>([[path, currentBytes]]);
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentLocal: LocalFileEntry = {
      ...reviewedLocal,
      hash: await sha256Hex(currentBytes),
      size: currentBytes.byteLength,
      mtime: 2,
    };
    const adapterOverrides = {
      stat: vi.fn(async (target: string) => {
        const bytes = files.get(target);
        return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
      }),
      readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
      writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
      remove: vi.fn(async (target: string) => { files.delete(target); }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.set(to, bytes);
        files.delete(from);
      }),
    };
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: remoteBytes.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: currentLocal }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides,
      stateOverrides: { beginMutationIntent },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(new Uint8Array(files.get(path)!)).toEqual(new Uint8Array(remoteBytes));
    expect(beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      expectedLocal: { exists: true, hash: currentLocal.hash, size: currentLocal.size },
    }));
  });

  it("keepRemote abandons its managed-config intent when the file changes in the final CAS window", async () => {
    const path = ".obsidian/app.json";
    const reviewedBytes = new TextEncoder().encode('{"theme":"old"}').buffer;
    const capturedBytes = new TextEncoder().encode('{"theme":"captured"}').buffer;
    const racedBytes = new TextEncoder().encode('{"theme":"raced"}').buffer;
    const remoteBytes = new TextEncoder().encode('{"theme":"remote"}').buffer;
    const files = new Map<string, ArrayBuffer>([[path, racedBytes]]);
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const capturedLocal: LocalFileEntry = {
      ...reviewedLocal,
      hash: await sha256Hex(capturedBytes),
      size: capturedBytes.byteLength,
      mtime: 2,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: remoteBytes.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: capturedLocal }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 3 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
      },
      stateOverrides: { abandonMutationIntent },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(new Uint8Array(files.get(path)!)).toEqual(new Uint8Array(racedBytes));
    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
  });

  it("Preflight P0 — keepLocal rejects a decision after local content changes", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    let remoteMutated = false;
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path,
          driveId: "note-id",
          size: 1,
          mtime: 1,
          eTag: "etag-reviewed",
          cTag: "ctag-reviewed",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
      }),
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([2]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(async () => {
        remoteMutated = true;
        return { id: "uploaded-id", eTag: "etag-uploaded" };
      }),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remoteMutated).toBe(false);
  });

  it("Preflight P0 — keepLocal uses the reviewed remote eTag as a CAS token", async () => {
    const path = "note.md";
    const reviewedETag = "etag-reviewed";
    let remoteMutated = false;
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1,
          mtime: 1,
          binary: false,
        },
        remote: {
          path,
          driveId: "note-id",
          size: 1,
          mtime: 1,
          eTag: reviewedETag,
          cTag: "ctag-reviewed",
        },
      }],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, _content: ArrayBuffer, _onProgress?: unknown, eTag?: string) => {
          if (eTag === reviewedETag) {
            throw new OneDriveError(
              OneDriveErrorType.PreconditionFailed,
              "remote changed after review",
              412,
            );
          }
          remoteMutated = true;
          return { id: "overwritten-id", eTag: "etag-overwritten" };
        },
      ),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remoteMutated).toBe(false);
  });

  it("Preflight P0 — confirmRemoteDelete rejects a decision after local content changes", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const remove = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local: reviewedLocal,
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
      }),
      adapterOverrides: { remove },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remove).not.toHaveBeenCalled();
  });

  it("keepRemote stops after download when the reviewed local version changes", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([8]).buffer);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "note-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "ctag-reviewed",
        },
      }],
      inspectFile: vi.fn()
        .mockResolvedValueOnce({ status: "present", entry: reviewedLocal })
        .mockResolvedValueOnce({
          status: "present",
          entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
        }),
      adapterOverrides: { writeBinary },
      downloadFile,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it("does not permanently delete when moving the local file to trash fails", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const remove = vi.fn().mockResolvedValue(undefined);
    const removePendingDelete = vi.fn().mockResolvedValue(undefined);
    const trashFile = vi.fn().mockRejectedValue(new Error("trash unavailable"));
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local: reviewedLocal,
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: reviewedLocal }),
      adapterOverrides: { remove },
      stateOverrides: { removePendingDelete },
      vaultFile: { path },
      fileManager: { trashFile },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalledWith(path);
    expect(removePendingDelete).not.toHaveBeenCalled();
  });

  it("rejects a legacy pending conflict that has no decision token", async () => {
    const path = "legacy.md";
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      preserveMissingDecisionTokens: true,
      uploadFile,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("refreshes the pending conflict when the remote version changed before keepRemote", async () => {
    const path = "remote-changed.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const downloadFile = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "old-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "new-id", size: 2, mtime: 2, eTag: "etag-new",
      }),
      stateOverrides: { addPendingConflict },
      downloadFile,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(downloadFile).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      path,
      remote: expect.objectContaining({ driveId: "new-id", eTag: "etag-new" }),
      decisionToken: expect.objectContaining({
        remote: { exists: true, driveId: "new-id", eTag: "etag-new" },
      }),
    }));
  });

  it("refreshes the pending conflict when keepLocal loses the final If-Match race", async () => {
    const path = "upload-raced.md";
    const local: LocalFileEntry = {
      path, hash: await sha256Hex(new Uint8Array([1]).buffer), size: 1, mtime: 1, binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce({ driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old" })
      .mockResolvedValueOnce({ driveId: "remote-id", size: 2, mtime: 2, eTag: "etag-new" });
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      getFileMetadata,
      stateOverrides: { addPendingConflict },
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) },
      uploadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.PreconditionFailed, "raced", 412),
      ),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      remote: expect.objectContaining({ eTag: "etag-new" }),
      decisionToken: expect.objectContaining({
        remote: { exists: true, driveId: "remote-id", eTag: "etag-new" },
      }),
    }));
  });

  it("does not write keepRemote content when the remote version changes during download", async () => {
    const path = "remote-raced.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const reviewedRemote = {
      path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "",
    } as RemoteFileEntry;
    const writeBinary = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce({ driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old" })
      .mockResolvedValueOnce({ driveId: "remote-id", size: 2, mtime: 2, eTag: "etag-new" });
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote: reviewedRemote }],
      getFileMetadata,
      stateOverrides: { addPendingConflict },
      downloadFile: vi.fn().mockResolvedValue(new Uint8Array([7]).buffer),
      adapterOverrides: { writeBinary },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(writeBinary).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      remote: expect.objectContaining({ eTag: "etag-new" }),
    }));
  });

  it("does not write keepRemote content when downloaded bytes fail the reviewed hash", async () => {
    const path = "hash-mismatch.bin";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: true,
    };
    const expectedContent = new Uint8Array([1]).buffer;
    const reviewedRemote = {
      path,
      driveId: "remote-id",
      size: 1,
      mtime: 1,
      eTag: "etag-reviewed",
      cTag: "",
      sha256Hash: await sha256Hex(expectedContent),
    } as RemoteFileEntry;
    const writeBinary = vi.fn();
    const recordMutationReceipt = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([2]).buffer);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote: reviewedRemote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      stateOverrides: { recordMutationReceipt },
      downloadFile,
      adapterOverrides: { writeBinary },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("keeps the local file when a remote deletion decision is stale because the path reappeared", async () => {
    const path = "reappeared.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const remove = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const removePendingDelete = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path, local }],
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "new-id", size: 1, mtime: 2, eTag: "etag-new",
      }),
      adapterOverrides: { remove },
      stateOverrides: { addPendingConflict, removePendingDelete },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(remove).not.toHaveBeenCalledWith(path);
    expect(addPendingConflict).toHaveBeenCalledTimes(1);
    expect(removePendingDelete).toHaveBeenCalledWith(path);
  });

  it("rejects a decision when its ancestor or account binding changed", async () => {
    const path = "ancestor.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "id", size: 1, mtime: 1, eTag: "etag", cTag: "" },
        decisionToken: {
          version: 1,
          vaultName: "testVault",
          accountId: "old-account",
          scope: { ...TEST_SYNC_SCOPE, accountId: "old-account" },
          local: { exists: true, hash: local.hash, size: local.size },
          remote: { exists: true, driveId: "id", eTag: "etag" },
          ancestorHash: "old-ancestor",
        },
      }],
      stateOverrides: {
        boundAccountId: "account-test",
        baseSnapshot: [{ path, hash: "new-ancestor", size: 1, eTag: "etag" }],
      },
      uploadFile,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("queues repeated item actions so later clicks do not fail behind the first transfer", async () => {
    let resolveFirstUpload: ((value: { id: string; eTag: string }) => void) | null = null;
    const startedPaths: string[] = [];
    const progressStore = new SyncProgressStore();
    const uploadFile = vi.fn().mockImplementation(
      (_vaultName: string, path: string) => {
        startedPaths.push(path);
        if (path === "a.md") {
          return new Promise<{ id: string; eTag: string }>((resolve) => {
            resolveFirstUpload = resolve;
          });
        }
        return Promise.resolve({ id: `id-${path}`, eTag: `etag-${path}` });
      },
    );

    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile,
      progressStore,
    });

    const firstQueued = executor.resolveConflictKeepLocal("a.md");
    const secondQueued = executor.resolveConflictKeepLocal("b.md");
    let settled = false;
    void Promise.all([firstQueued, secondQueued]).then(() => {
      settled = true;
    });

    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(true);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
      expect(startedPaths).toEqual(["a.md"]);
    });
    expect(settled).toBe(false);
    expect(progressStore.state).toMatchObject({
      phase: "executing",
      current: 1,
      total: 2,
      currentFile: "a.md",
      completedFiles: [],
    });

    resolveFirstUpload?.({ id: "id-a", eTag: "etag-a-new" });
    await waitUntil(() => {
      expect(startedPaths).toEqual(["a.md", "b.md"]);
      expect(progressStore.state.current).toBe(2);
      expect(progressStore.state.total).toBe(2);
      expect(progressStore.state.completedFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "a.md", status: "upload" }),
      ]));
    });
    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(false);
      expect(executor.isSideActionQueued("b.md")).toBe(false);
      expect(settled).toBe(true);
    });
    expect(progressStore.state.phase).toBe("done");
    expect(progressStore.state.completedFiles).toEqual([
      expect.objectContaining({ path: "a.md", status: "upload" }),
      expect.objectContaining({ path: "b.md", status: "upload" }),
    ]);
  });

  it("queues one remote-delete confirmation batch through the existing side-action progress", async () => {
    const progressStore = new SyncProgressStore();
    const notice = makeNoticeRecorder();
    const localByPath = new Map<string, LocalFileEntry>([
      ["a.md", { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false }],
      ["b.md", { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false }],
    ]);
    let releaseFirstDelete: (() => void) | null = null;
    const remove = vi.fn().mockImplementation((path: string) => {
      if (path !== "a.md") return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstDelete = resolve;
      });
    });
    const executor = makeProgressAwareExecutor({
      progressStore,
      noticeCenter: notice.center,
      pendingRemoteDeletes: [...localByPath.values()].map((local) => ({
        type: SyncActionType.ConfirmLocalDelete,
        path: local.path,
        local,
      })),
      inspectFile: vi.fn().mockImplementation(async (path: string) => ({
        status: "present",
        entry: localByPath.get(path),
      })),
      adapterOverrides: { remove },
    });

    const completion = executor.confirmRemoteDeletes(["a.md", "b.md"]);
    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(true);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
      expect(progressStore.state).toMatchObject({
        phase: "executing",
        current: 1,
        total: 2,
        currentFile: "a.md",
      });
    });

    releaseFirstDelete?.();
    await completion;

    expect(remove.mock.calls.map(([path]) => path)).toEqual(["a.md", "b.md"]);
    expect(progressStore.state).toMatchObject({ phase: "done", current: 2, total: 2 });
    expect(progressStore.state.completedFiles).toEqual([
      expect.objectContaining({ path: "a.md", status: "delete" }),
      expect.objectContaining({ path: "b.md", status: "delete" }),
    ]);
    expect(notice.messages).not.toContain("notice.delete.confirmed");
  });

  it("keeps one side-action result batch across sequential conflict clicks", async () => {
    const progressStore = new SyncProgressStore();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(async (_vaultName: string, path: string) => ({
        id: `id-${path}`,
        eTag: `etag-${path}`,
      })),
      progressStore,
    });

    await executor.resolveConflictKeepLocal("a.md");
    expect(progressStore.state).toMatchObject({ phase: "done", current: 1, total: 1 });
    expect(progressStore.state.completedFiles.map((file) => file.path)).toEqual(["a.md"]);

    await executor.resolveConflictKeepLocal("b.md");
    expect(progressStore.state).toMatchObject({ phase: "done", current: 2, total: 2 });
    expect(progressStore.state.completedFiles.map((file) => file.path)).toEqual(["a.md", "b.md"]);
  });

  it("invalidates an in-flight side action and drops later queued actions", async () => {
    let resolveFirstUpload: ((value: { eTag: string }) => void) | null = null;
    const updateBaseEntry = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockImplementation(
      (_vaultName: string, path: string) => {
        if (path === "a.md") {
          return new Promise<{ eTag: string }>((resolve) => {
            resolveFirstUpload = resolve;
          });
        }
        return Promise.resolve({ eTag: `etag-${path}` });
      },
    );
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile,
      stateOverrides: {
        updateBaseEntry,
        applyRemoteMutations,
        removePendingConflict,
      },
    });

    const firstAction = executor.resolveConflictKeepLocal("a.md");
    const secondAction = executor.resolveConflictKeepLocal("b.md");
    await waitUntil(() => {
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
    });

    executor.invalidateLifecycle("unload");
    resolveFirstUpload?.({ eTag: "etag-a-new" });

    await waitUntil(() => {
      expect(executor.hasSideActionsInFlight).toBe(false);
    });
    await Promise.all([firstAction, secondAction]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(updateBaseEntry).not.toHaveBeenCalled();
    expect(applyRemoteMutations).not.toHaveBeenCalled();
    expect(removePendingConflict).not.toHaveBeenCalled();
  });
});

describe("S1a — sync run phase observability", () => {
  it("emits one structured phase summary for a completed production run", async () => {
    const diagLog = vi.fn();
    const diag = {
      log: diagLog,
      warn: vi.fn(),
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DiagnosticLogger;
    const beginRunMetrics = vi.fn();
    const finishRunMetrics = vi.fn().mockReturnValue({
      schemaVersion: 1,
      totals: {
        attempts: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        elapsedMs: 4,
        effectiveBytes: 0,
        retriedBytes: 0,
        peakConcurrency: 1,
      },
      endpoints: {
        delta: {
          attempts: 1,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          elapsedMs: 4,
          effectiveBytes: 0,
          retriedBytes: 0,
          peakConcurrency: 1,
          statusCategories: { success: 1 },
        },
      },
    });
    const state = makeActiveV2State([], [], {
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    });
    const setRemoteState = state.setRemoteState as ReturnType<typeof vi.fn>;
    const adapter = makeMockAdapter();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        beginRunMetrics,
        finishRunMetrics,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "delta-token-next",
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag,
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(setRemoteState).toHaveBeenCalledTimes(1);
    expect(beginRunMetrics).toHaveBeenCalledTimes(1);
    expect(finishRunMetrics).toHaveBeenCalledTimes(1);
    expect(diagLog).toHaveBeenCalledWith(
      "onedrive",
      "sync network summary",
      expect.objectContaining({
        schemaVersion: 1,
        totals: expect.objectContaining({ attempts: 1, peakConcurrency: 1 }),
      }),
    );
    expect(diagLog).toHaveBeenCalledWith(
      "execute",
      "sync file transfer summary",
      expect.objectContaining({
        schemaVersion: 3,
        platform: expect.stringMatching(/^(desktop|mobile)$/),
        upload: expect.objectContaining({
          stagesMs: expect.objectContaining({
            sourceRead: expect.any(Number),
            contentTransfer: expect.any(Number),
            contentHash: expect.any(Number),
          }),
        }),
        download: expect.objectContaining({
          stagesMs: expect.objectContaining({
            contentTransfer: expect.any(Number),
            contentHash: expect.any(Number),
            remoteVersionVerify: expect.any(Number),
            localVersionGuard: expect.any(Number),
            localCommit: expect.any(Number),
          }),
        }),
        mutationPersistence: expect.objectContaining({
          intentWrites: expect.any(Number),
          receiptWrites: expect.any(Number),
          checkpointOperations: expect.any(Number),
          checkpointCommits: expect.any(Number),
          checkpointFailures: expect.any(Number),
          stagesMs: expect.objectContaining({
            intentPersist: expect.any(Number),
            receiptPersist: expect.any(Number),
            checkpointV2Commit: expect.any(Number),
            checkpointLedgerClear: expect.any(Number),
            checkpointTotal: expect.any(Number),
          }),
        }),
      }),
    );
    const summaryCall = diagLog.mock.calls.find(
      ([category, message]) => category === "lifecycle" && message === "sync run phase summary",
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[2]).toMatchObject({
      schemaVersion: 2,
      platform: expect.stringMatching(/^(desktop|mobile)$/),
      mode: "manual",
      status: "success",
      readOnlyPreview: false,
      counts: {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      },
      phasesMs: {
        recovery: expect.any(Number),
        scan: expect.any(Number),
        remotePrepare: expect.any(Number),
        baseline: expect.any(Number),
        remoteChanges: expect.any(Number),
        planning: expect.any(Number),
        reviewWait: expect.any(Number),
        transfer: expect.any(Number),
        commit: expect.any(Number),
      },
      totalMs: expect.any(Number),
    });
    for (const value of Object.values(summaryCall?.[2].phasesMs ?? {})) {
      expect(value).toBeGreaterThanOrEqual(0);
    }

    diagLog.mockClear();
    const publishPreview = vi.fn().mockResolvedValue(true);
    const previewResult = await executor.run(
      "manual",
      { onFirstSyncPreview: publishPreview },
      false,
      undefined,
      { readOnlyPreview: true },
    );

    expect(previewResult.success).toBe(false);
    expect(publishPreview).toHaveBeenCalledTimes(1);
    const previewSummary = diagLog.mock.calls.find(
      ([category, message]) => category === "lifecycle" && message === "sync run phase summary",
    );
    expect(previewSummary?.[2]).toMatchObject({
      schemaVersion: 2,
      platform: expect.stringMatching(/^(desktop|mobile)$/),
      mode: "manual",
      status: "stopped",
      readOnlyPreview: true,
      phasesMs: {
        reviewWait: expect.any(Number),
        transfer: 0,
        commit: 0,
      },
    });
  });

  it("keeps a platform-neutral 500-file zero-change production run to one scan and one delta call", async () => {
      const entries: LocalFileEntry[] = Array.from({ length: 500 }, (_, index) => ({
        path: `note-${index.toString().padStart(3, "0")}.md`,
        size: 128,
        mtime: 1,
        hash: "aa".repeat(32),
        binary: false,
      }));
      const remoteEntries: RemoteFileEntry[] = entries.map((entry, index) => ({
        path: entry.path,
        driveId: `remote-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: entry.size,
        mtime: entry.mtime,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
        sha256Hash: entry.hash,
      }));
      const baseEntries: BaseFileEntry[] = entries.map((entry, index) => ({
        path: entry.path,
        size: entry.size,
        hash: entry.hash,
        eTag: `etag-${index}`,
      }));
      const scanAll = vi.fn().mockResolvedValue({
        entries,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      });
      const getDelta = vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "delta-token-next",
      });
      const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
      const diagnosticsEnabled = { value: false };
      const diag = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn(() => diagnosticsEnabled.value),
      } as unknown as DiagnosticLogger;
      const beginRunMetrics = vi.fn();
      const finishRunMetrics = vi.fn().mockReturnValue(null);
      const restoreVaultScope = vi.fn().mockReturnValue(true);
      const initVaultScope = vi.fn().mockResolvedValue({
        driveId: TEST_SYNC_SCOPE.driveId,
        vaultFolderId: TEST_SYNC_SCOPE.vaultFolderId,
        filesRootId: TEST_SYNC_SCOPE.filesRootId,
      });
      const state = makeActiveV2State(remoteEntries, baseEntries, {
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingIssues: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime,
        incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
      });
      const setRemoteState = state.setRemoteState as ReturnType<typeof vi.fn>;
      const executor = new SyncExecutor(
        makeMockOneDrive({
          getDelta,
          beginRunMetrics,
          finishRunMetrics,
          restoreVaultScope,
          initVaultScope,
        }),
        {
          vault: {
            adapter: makeMockAdapter(),
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll,
          getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        } as unknown as LocalScanner,
        state,
        "testVault",
        undefined,
        undefined,
        diag,
      );
      const withoutDiagnosticsMs: number[] = [];
      const withDiagnosticsMs: number[] = [];

      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withoutDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }
      diagnosticsEnabled.value = true;
      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }

      expect(scanAll).toHaveBeenCalledTimes(10);
      expect(getDelta).toHaveBeenCalledTimes(10);
      expect(restoreVaultScope).toHaveBeenCalledTimes(10);
      expect(initVaultScope).not.toHaveBeenCalled();
      expect(setRemoteState).toHaveBeenCalledTimes(10);
      expect(setLastSyncTime).toHaveBeenCalledTimes(10);
      expect(beginRunMetrics).toHaveBeenCalledTimes(5);
      expect(finishRunMetrics).toHaveBeenCalledTimes(5);
      const medianWithoutDiagnostics = [...withoutDiagnosticsMs].sort((a, b) => a - b)[2];
      const medianWithDiagnostics = [...withDiagnosticsMs].sort((a, b) => a - b)[2];
      const allowedProbeOverheadMs = Math.max(medianWithoutDiagnostics * 0.05, 10);
      expect(medianWithDiagnostics - medianWithoutDiagnostics).toBeLessThanOrEqual(allowedProbeOverheadMs);
      console.info("[a0p-production-entry]", JSON.stringify({
        schemaVersion: 1,
        mode: "platform-neutral",
        files: entries.length,
        roundsPerMode: 5,
        diagnosticsOffMedianMs: Number(medianWithoutDiagnostics.toFixed(3)),
        diagnosticsOnMedianMs: Number(medianWithDiagnostics.toFixed(3)),
        diagnosticsOverheadMs: Number((medianWithDiagnostics - medianWithoutDiagnostics).toFixed(3)),
        allowedProbeOverheadMs: Number(allowedProbeOverheadMs.toFixed(3)),
        operations: {
          fullScansPerRun: scanAll.mock.calls.length / 10,
          deltaCallsPerRun: getDelta.mock.calls.length / 10,
          remoteStateCommitsPerRun: setRemoteState.mock.calls.length / 10,
          healthTimeCommitsPerRun: setLastSyncTime.mock.calls.length / 10,
        },
      }));
  });
});
