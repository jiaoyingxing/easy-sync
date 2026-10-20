// 同步安全测试的共享夹具与帮手（原 tests/sync-safety.test.ts 前置块）。
// 拆分后由各 sync-safety-*.test.ts 导入；remote-enum-checkpoint.test.ts 也从这里取夹具。
// 原文件里「P0.1／P0.2／P0.3 是三条数据丢失向量的最小安全网」那段说明，
// 随对应用例移到了 tests/sync-safety-scan-health.test.ts 的文件头。

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeAll } from "vitest";
import * as obsidian from "obsidian";
import { Platform, TFile, TFolder, type Plugin } from "obsidian";
import { sha256Hex } from "../../src/crypto";
import { getEasySyncPaths } from "../../src/obsidian-compat";
import { BundleReviewBytesCache } from "../../src/sync/bundle-review-bytes-cache";
import { sameSyncScope, SyncActionType } from "../../src/sync/types";
import { planDigest } from "../../src/sync/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  ManualMutationResolutionV1,
  MutationIntentV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "../../src/sync/types";
import { SyncExecutor } from "../../src/sync/sync-executor";
import type { SyncResult } from "../../src/sync/sync-executor";
import {
  emptyDeletionLedgerV1,
  upsertDeletionLedgerEntryV1,
  type DeletionLedgerEntryV1,
} from "../../src/sync/deletion-ledger";
import { OneDriveClient, ResponseByteBudgetError } from "../../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../../src/onedrive/types";
import type { LocalScanner } from "../../src/sync/local-scanner";
import type { PendingIssue } from "../../src/sync/types";
import { generateFileDecisionPlanV2 } from "../../src/sync/file-decision-planner-v2";
import { StateManager } from "../../src/sync/state-manager";
import { I18n } from "../../src/i18n";
import { SyncProgressStore } from "../../src/sync/sync-progress";
import type { DiagnosticLogger } from "../../src/sync/diagnostic-logger";
import { EasySyncNoticeCenter } from "../../src/ui/notice-center";
import {
  reduceFileStateEnvelopeV2,
} from "../../src/sync/file-state-reducer-v2";
import {
  isFolderMutationIntent,
  reduceFolderStateEnvelopeV2,
} from "../../src/sync/folder-state-reducer-v2";
import {
  attachBaseAncestorHashesV2,
  projectStatePathViewV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "../../src/sync/file-state-controller-v2";
import type { SyncAnchorV2 } from "../../src/sync/state-envelope-v2";
import { createFileStateShadowEnvelopeV2 } from "./file-state-shadow-v2";
import { projectRemoteIndexV2 } from "../../src/sync/remote-index-v2";
import {
  makePublic113InterruptedUploadBatch,
  PUBLIC_113_NETWORK_RECOVERY_INCIDENT,
} from "./fixtures/network-recovery-incidents";
import { V2FilePlanTestHarness } from "./v2-file-plan-test-harness";
import type {
  CommunityPluginManifestObservationV1,
} from "../../src/sync/community-plugin-bundle";

// ---- Shared test helpers ----

export const TEST_SYNC_SCOPE = {
  accountId: "",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};
export const EASY_SYNC_TMP_DIR = getEasySyncPaths(".obsidian").tmpDir;

export function makeMockAdapter(overrides: Record<string, unknown> = {}) {
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

export function makeDownloadLocalStore(onWrite?: () => Promise<void>) {
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

export function makeMockOneDrive(overrides: Record<string, unknown> = {}) {
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
    getFileMetadataByPaths: vi.fn().mockResolvedValue(new Map()),
    getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
    getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "tok" }),
    fullScan: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as OneDriveClient;
}

export function remoteStateStub() {
  const sizeExclusionBaseline: string[] = [];
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
    getSizeExclusionBaseline: vi.fn((): string[] => [...sizeExclusionBaseline]),
    commitSizeExclusionBaseline: vi.fn(async (paths: readonly string[]) => {
      sizeExclusionBaseline.splice(0, sizeExclusionBaseline.length, ...paths);
    }),
    cacheBaseContent: vi.fn(),
    getBaseContent: vi.fn().mockReturnValue(undefined),
    getBaseEntry: vi.fn((path: string) => undefined),
    // 删除记录簿：桩状态没有 committed V2 信封，路径取不到锚点身份——照实返回
    // undefined（调用方的「拿不到 id 就不记」边界）。
    remoteIdForPath: vi.fn((_path: string) => undefined),
    mutationLedger: [],
    hasMutationLedgerCorruption: false,
    beginMutationIntent: vi.fn().mockResolvedValue(undefined),
    recordMutationReceipt: vi.fn().mockResolvedValue(undefined),
    abandonMutationIntent: vi.fn().mockResolvedValue(undefined),
    commitMutationCheckpoint: vi.fn().mockResolvedValue(undefined),
    commitMutationCheckpoints: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeActiveV2State(
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
  let deletionLedger = emptyDeletionLedgerV1();
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
  if (Array.isArray(overrides.folderAnchors)) {
    const seeded = overrides.folderAnchors as Array<{
      remoteId: string;
      lastPath: string;
      parentId?: string;
      eTag?: string;
    }>;
    const next: Record<string, unknown> = {};
    for (const anchor of seeded) {
      const anchorId = `folder:${anchor.remoteId}`;
      next[anchorId] = {
        anchorId,
        remoteId: anchor.remoteId,
        lastPath: anchor.lastPath,
        parentRemoteId: anchor.parentId,
        remoteETag: anchor.eTag,
        confirmedGeneration: 1,
        confirmedAt: 1,
      };
    }
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: next,
    };
  }
  if (Array.isArray(overrides.staleFileAnchors)) {
    // Test-only device-state modeling: a committed anchor may keep a Graph id
    // that the current remote index no longer maps to the same path (a
    // same-path delete-recreate replaced the object identity).
    const staleByPath = new Map(
      (overrides.staleFileAnchors as Array<{
        path: string;
        remoteId: string;
        eTag?: string;
      }>).map((entry) => [entry.path, entry]),
    );
    const rebound: Record<string, SyncAnchorV2> = {};
    for (const anchor of Object.values(envelope.anchors.byAnchorId)) {
      const stale = staleByPath.get(anchor.lastPath);
      const nextAnchor = stale
        ? {
            ...anchor,
            anchorId: `shadow:${stale.remoteId}`,
            remoteId: stale.remoteId,
            ...(stale.eTag !== undefined
              ? { remoteETag: stale.eTag }
              : {}),
          }
        : anchor;
      rebound[nextAnchor.anchorId] = nextAnchor;
    }
    envelope.anchors.byAnchorId = rebound;
  }

  const state = {
    ...remoteStateStub(),
    legacyAutoSyncAllowed: false,
    isV2StateActive: true,
    retireAllFirstSyncVerificationEvidence: vi.fn().mockResolvedValue(0),
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
    retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
    getBaseEntry: vi.fn((path: string) =>
      baseSnapshot.find((entry) => entry.path === path)),
    // 删除记录簿：真实涨落（同族命令式 reduce），并在归约删锚点前按路径读身份。
    remoteIdForPath: vi.fn((path: string) =>
      Object.values(envelope.anchors.byAnchorId).find(
        (anchor) => anchor.lastPath === path,
      )?.remoteId),
    get deletionLedgerEntries() {
      return deletionLedger.entries;
    },
    recordCloudDeletion: vi.fn(async (entry: DeletionLedgerEntryV1) => {
      deletionLedger = upsertDeletionLedgerEntryV1(deletionLedger, entry);
    }),
    upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
    prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
    upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
    prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
    // 片④ 本机独有条目记录（单向轮次会核对一次；双向轮次不调用）。
    localOnlyCopyEntries: [],
    localOnlyCreatedEntries: [],
    reconcileLocalOnlyEntries: vi.fn().mockResolvedValue(undefined),
    retireLocalOnlyEntries: vi.fn().mockResolvedValue(undefined),
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
    const previousEnvelope = envelope;
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
    // Fidelity with replaceRemoteStateEnvelopeV2: the real controller
    // replaces only the remote index and carries folderAnchors over
    // unchanged (file-state-controller-v2.ts — withNextCommit spreads the
    // previous envelope).
    envelope.folderAnchors = previousEnvelope.folderAnchors ?? {
      schemaVersion: 2,
      byAnchorId: {},
    };
    // Keep identity bindings across remote observations: a committed anchor
    // stays bound to its Graph id even when that id moved to another path
    // (the shadow seed re-binds anchors by current path, which would fake an
    // anchor that lost its identity after a remote move). The anchor keeps
    // its previous lastPath so identity-rename planning can detect the move.
    const nextPathByRemoteId = projectRemoteIndexV2(envelope.remoteIndex);
    const retained: Record<string, SyncAnchorV2> = {};
    for (const anchor of Object.values(previousEnvelope.anchors.byAnchorId)) {
      if (anchor.remoteId === undefined) continue;
      if (!nextPathByRemoteId.has(anchor.remoteId)) continue;
      retained[anchor.anchorId] = { ...anchor };
    }
    if (Object.keys(retained).length > 0) {
      const retainedPaths = new Set(
        Object.values(retained).map((anchor) => anchor.lastPath),
      );
      const rebuilt = { ...envelope.anchors.byAnchorId };
      for (const [anchorId, anchor] of Object.entries(rebuilt)) {
        if (retainedPaths.has(anchor.lastPath)) delete rebuilt[anchorId];
      }
      envelope.anchors.byAnchorId = { ...rebuilt, ...retained };
    }
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
  state.rebaseReceiptedRenameSpelling = vi.fn(async (input: {
    expected: MutationLedgerEntryV1;
    path: string;
    receipt: MutationReceiptV1;
  }) => {
    const record = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId
        === input.expected.intent.operationId,
    );
    if (!record) {
      throw new Error(
        `Mutation intent missing: ${input.expected.intent.operationId}`,
      );
    }
    if (
      record.intent.path !== input.expected.intent.path
      || JSON.stringify(record.receipt) !== JSON.stringify(input.expected.receipt)
    ) {
      throw new Error(
        `Mutation changed before its spelling rebase: ${input.expected.intent.operationId}`,
      );
    }
    record.intent.path = input.path;
    record.receipt = structuredClone(input.receipt);
  });
  state.abandonMutationIntent = vi.fn(async (operationId) => {
    const index = state.mutationLedger.findIndex(
      (record) => record.intent.operationId === operationId,
    );
    if (index >= 0) state.mutationLedger.splice(index, 1);
  });
  state.settleReplacedIdentityUploadResolved = vi.fn(async (input: {
    expectedRecord: MutationLedgerEntryV1;
    entry: BaseFileEntry;
    oldRemoteId: string;
  }) => {
    const index = state.mutationLedger.findIndex(
      (record) => record.intent.operationId
        === input.expectedRecord.intent.operationId,
    );
    if (index < 0) return false;
    if (JSON.stringify(state.mutationLedger[index])
      !== JSON.stringify(input.expectedRecord)) {
      return false;
    }
    const current = envelope;
    envelope = upsertBaseStateEnvelopeV2(
      current,
      [input.entry],
      committedAt + 1,
    );
    commitSeq = envelope.meta.commitSeq;
    committedAt = envelope.meta.committedAt;
    baseSnapshot = [
      ...baseSnapshot.filter((entry) => entry.path !== input.entry.path),
      { ...input.entry },
    ].sort((left, right) => left.path.localeCompare(right.path));
    state.baseSnapshot = baseSnapshot;
    state.mutationLedger.splice(index, 1);
    state.pendingRemoteDeletes = state.pendingRemoteDeletes.filter((item) =>
      !(item.path === input.entry.path
        && item.decisionToken?.remote.exists === true
        && item.decisionToken.remote.driveId === input.oldRemoteId));
    return true;
  });
  state.retireUnreceiptedMutationIntentsForScopeExit = vi.fn(async (
    expectedRecords: MutationLedgerEntryV1[],
  ) => {
    if (expectedRecords.some((expected) => {
      const active = state.mutationLedger.find(
        (record) => record.intent.operationId === expected.intent.operationId,
      );
      return !active || JSON.stringify(active) !== JSON.stringify(expected);
    })) throw new Error("Mutation changed before scope exit");
    const operationIds = new Set(
      expectedRecords.map((record) => record.intent.operationId),
    );
    state.mutationLedger.splice(
      0,
      state.mutationLedger.length,
      ...state.mutationLedger.filter(
        (record) => !operationIds.has(record.intent.operationId),
      ),
    );
    return expectedRecords.length;
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
      // 目录 mutation 由目录 reducer 收口（片④ 的上传动作会先补父目录链）。
      envelope = isFolderMutationIntent(record.intent)
        ? reduceFolderStateEnvelopeV2(envelope, record as never)
        : reduceFileStateEnvelopeV2(envelope, record as never);
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
  state.replaceManualMutationResolution = vi.fn(async (
    expectedRecord: MutationLedgerEntryV1,
    resolution: ManualMutationResolutionV1,
  ) => {
    const record = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === expectedRecord.intent.operationId,
    ) as MutationLedgerEntryV1 | undefined;
    if (
      !record
      || !record.manualResolution
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
  state.beginCommunityPluginBundleSettlement = vi.fn(async (
    expectedRecords: MutationLedgerEntryV1[],
    expectedConflicts: SyncPlanItem[],
    entry: MutationLedgerEntryV1,
  ) => {
    const expectedIds = new Set(
      expectedRecords.map((record) => record.intent.operationId),
    );
    if (expectedRecords.some((expected) => {
      const active = state.mutationLedger.find(
        (candidate) => candidate.intent.operationId === expected.intent.operationId,
      );
      return !active || JSON.stringify(active) !== JSON.stringify(expected);
    }) || expectedConflicts.some((expected) => {
      const active = state.pendingConflicts.find(
        (candidate) => candidate.path === expected.path,
      );
      return !active || JSON.stringify(active) !== JSON.stringify(expected);
    }) || state.mutationLedger.some((candidate) =>
      candidate.intent.operationId === entry.intent.operationId
      && !expectedIds.has(candidate.intent.operationId))) return false;
    state.mutationLedger.push(structuredClone(entry));
    return true;
  });
  state.recordCommunityPluginBundleSettlementReceipts = vi.fn(async (
    expectedEntry: MutationLedgerEntryV1,
    receipts: MutationReceiptV1[],
  ) => {
    const active = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === expectedEntry.intent.operationId,
    ) as MutationLedgerEntryV1 | undefined;
    if (
      !active
      || JSON.stringify(active) !== JSON.stringify(expectedEntry)
      || active.manualResolution?.version !== 2
    ) return false;
    const receiptById = new Map(
      receipts.map((receipt) => [receipt.operationId, receipt]),
    );
    active.manualResolution.members = active.manualResolution.members.map(
      (member) => ({
        ...member,
        receipt: receiptById.has(member.intent.operationId)
          ? structuredClone(receiptById.get(member.intent.operationId)!)
          : member.receipt,
      }),
    );
    return true;
  });
  state.commitCommunityPluginBundleSettlementCheckpoint = vi.fn(async (
    expectedEntry: MutationLedgerEntryV1,
  ) => {
    if (expectedEntry.manualResolution?.version !== 2) {
      throw new Error("bundle settlement missing");
    }
    for (const member of expectedEntry.manualResolution.members) {
      if (!member.receipt) throw new Error("bundle receipt missing");
      envelope = reduceFileStateEnvelopeV2(envelope, {
        intent: member.intent,
        receipt: member.receipt,
      });
    }
    const projection = projectStatePathViewV2(envelope);
    baseSnapshot = projection.baseEntries;
    remoteSnapshot = projection.remoteEntries;
    state.baseSnapshot = baseSnapshot;
    state.remoteSnapshot = remoteSnapshot;
    const retired = new Set([
      expectedEntry.intent.operationId,
      ...expectedEntry.manualResolution.predecessorOperationIds,
    ]);
    const conflictPaths = new Set(
      expectedEntry.manualResolution.conflictDecisions.map((item) => item.path),
    );
    state.mutationLedger.splice(
      0,
      state.mutationLedger.length,
      ...state.mutationLedger.filter(
        (candidate) => !retired.has(candidate.intent.operationId),
      ),
    );
    state.pendingConflicts.splice(
      0,
      state.pendingConflicts.length,
      ...state.pendingConflicts.filter(
        (candidate) => !conflictPaths.has(candidate.path),
      ),
    );
  });

  return state;
}

export function graphFolder(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    folder: { childCount: 1 },
    parentReference: { id: parentId },
  };
}


export async function makeMemoryState(
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

export function driveItem(
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

export function emptyScanner(): LocalScanner {
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

export async function makeManualResolutionHarness(input: {
  local?: Record<string, string>;
  remote?: Record<string, string>;
  action?: MutationIntentV1["action"];
  expectedLocalAtIntent?: boolean;
  localExcludedByCurrentScope?: boolean;
  remoteExcludedByCurrentScope?: boolean;
  sourcePath?: string;
  path: string;
  configDir?: string;
  receiptedRenameAnchorCollision?: boolean;
  pendingConflictPaths?: string[];
  /** 只有云端一侧的冲突行（本机已删、云端改过）：本机删除出口带着合法
   *  decisionToken，可直接驱动「保留本机＝删掉云端那份多余副本」分支。 */
  remoteOnlyConflictPaths?: string[];
  withLedger?: boolean;
  progressStore?: SyncProgressStore;
  /** 给了任一项就模拟真实宿主：它认得库里的文件，并且自己有写入面
   *  （F12 修复的「复制留底 + 宿主写入面原地写」分支；`commitDownloadedTempFile`
   *  的 hostVisible 判据＝宿主认得目标且 `vault.modify` 存在）。 */
  hostEditorMerge?: string;
  /** 宿主写入面「静默失败」：接口正常返回但磁盘没变（`DECISIONS` 2026-09-23 第 9 点④的现场）。 */
  hostWriteSilent?: boolean;
  /** 宿主写入面的调用记录，用于断言原地写入的内容与有界重试次数。 */
  hostWriteLog?: string[];
  i18n?: I18n;
  noticeCenter?: EasySyncNoticeCenter;
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
  const inspectLocal = vi.fn(async (
    path: string,
    options: Readonly<{ allowExcludedForRecovery?: boolean }> = {},
  ) => {
    if (
      input.localExcludedByCurrentScope
      && !options.allowExcludedForRecovery
    ) {
      return { status: "uncertain" as const, reason: "excluded" as const };
    }
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
    read: vi.fn(async (path: string) => {
      const bytes = localBytes.get(path);
      if (!bytes) throw new Error(`missing local: ${path}`);
      return new TextDecoder().decode(bytes);
    }),
    write: vi.fn(async (path: string, value: string) => {
      localBytes.set(path, encoder.encode(value).buffer);
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
    const separator = path.lastIndexOf("/");
    const parentPath = separator < 0 ? "" : path.slice(0, separator);
    const entry: RemoteFileEntry = {
      path,
      driveId: previous?.driveId ?? `uploaded-${path}`,
      parentId: previous?.parentId ?? ensureRemoteFolder(parentPath),
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
  const committedRemoteEntries = input.remoteExcludedByCurrentScope
    ? []
    : [...remoteFiles.values()].map((item) => item.entry);
  const committedBaseEntries: BaseFileEntry[] = [];
  let blockedIntent: MutationIntentV1 = {
    version: 1,
    operationId: "blocked-operation",
    planRevision: 1,
    scope,
    action: input.sourcePath ? "renameRemote" : input.action ?? "upload",
    path: input.path,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    expectedLocal: { exists: false },
    expectedRemote: { exists: false },
    createdAt: 1,
  };
  if (input.expectedLocalAtIntent) {
    const expectedLocal = localBytes.get(input.path);
    if (!expectedLocal) throw new Error("local intent harness requires a local file");
    blockedIntent = {
      ...blockedIntent,
      expectedLocal: {
        exists: true,
        hash: await sha256Hex(expectedLocal),
        size: expectedLocal.byteLength,
      },
    };
  }
  if (input.action === "download") {
    const expectedRemote = remoteFiles.get(input.path)?.entry;
    if (!expectedRemote) throw new Error("download harness requires a remote file");
    blockedIntent = {
      ...blockedIntent,
      expectedRemote: {
        exists: true,
        driveId: expectedRemote.driveId,
        eTag: expectedRemote.eTag,
        size: expectedRemote.size,
        sha256Hash: expectedRemote.sha256Hash,
      },
    };
  }
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
  const ledger: MutationLedgerEntryV1[] = input.withLedger === false
    ? []
    : [{
        intent: blockedIntent,
        receipt: blockedReceipt,
      }];
  const pendingConflicts: SyncPlanItem[] = [];
  for (const path of input.pendingConflictPaths ?? []) {
    const local = localBytes.get(path);
    const remote = remoteFiles.get(path)?.entry;
    if (!local || !remote) {
      throw new Error(`pending conflict harness requires both sides: ${path}`);
    }
    pendingConflicts.push({
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        hash: await sha256Hex(local),
        size: local.byteLength,
        mtime: 1,
        binary: false,
      },
      remote,
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: scope.accountId,
        scope,
        local: {
          exists: true,
          hash: await sha256Hex(local),
          size: local.byteLength,
        },
        remote: {
          exists: true,
          driveId: remote.driveId,
          eTag: remote.eTag,
        },
        ancestorHash: null,
      },
    });
  }
  for (const path of input.remoteOnlyConflictPaths ?? []) {
    const remote = remoteFiles.get(path)?.entry;
    if (!remote) {
      throw new Error(`remote-only conflict harness requires a remote file: ${path}`);
    }
    pendingConflicts.push({
      type: SyncActionType.Conflict,
      path,
      remote,
      reason: "reason.localDeletedRemoteModified",
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: scope.accountId,
        scope,
        local: { exists: false },
        remote: {
          exists: true,
          driveId: remote.driveId,
          eTag: remote.eTag,
        },
        ancestorHash: null,
      },
    });
  }
  const state = makeActiveV2State(committedRemoteEntries, committedBaseEntries, {
    mutationLedger: ledger,
    pendingConflicts,
    remoteFolders: [...remoteFoldersByPath.values()],
  });
  const getDriveItemMetadataById = vi.fn(async (driveId: string) => {
    const found = [...remoteFiles.values()].find(
      (current) => current.entry.driveId === driveId,
    );
    return found ? { id: driveId, eTag: found.entry.eTag } : null;
  });
  const downloadFile = vi.fn(async (_vault: string, path: string) => {
    const current = remoteFiles.get(path);
    if (!current) throw new Error(`missing remote: ${path}`);
    return current.bytes.slice(0);
  });
  const onedrive = makeMockOneDrive({
    uploadFile,
    deleteItem,
    moveItemById,
    getFileMetadata: vi.fn(async (_vault: string, path: string) => metadata(path)),
    getDriveItemMetadataById,
    downloadFile,
  });
  const hostWriteSurface = input.hostEditorMerge !== undefined
    || input.hostWriteSilent === true
    || input.hostWriteLog !== undefined;
  const executor = new SyncExecutor(
    onedrive,
    {
      vault: {
        configDir: input.configDir ?? ".obsidian",
        adapter,
        getAbstractFileByPath: vi.fn((path: string) =>
          localBytes.has(path) ? new TFile(path) : null),
        // 宿主写入面在场时宿主认得库索引里的文件；缺席＝没有可被切走的视图，
        // 下载保持原子替换（与 `commitDownloadedTempFile` 的路由判据一致）。
        getFileByPath: hostWriteSurface
          ? vi.fn((path: string) => (localBytes.has(path) ? new TFile(path) : null))
          : vi.fn().mockReturnValue(null),
        ...(hostWriteSurface
          ? {
              modify: vi.fn(async (file: TFile, data: string) => {
                input.hostWriteLog?.push(data);
                if (input.hostWriteSilent) return;
                await adapter.writeBinary(
                  file.path,
                  new TextEncoder().encode(`${data}${input.hostEditorMerge ?? ""}`).buffer,
                );
              }),
            }
          : {}),
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
    input.i18n,
    input.progressStore,
    undefined,
    undefined,
    undefined,
    undefined,
    input.noticeCenter,
  );
  return {
    adapter,
    deleteItem,
    downloadFile,
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

export function makeNoticeRecorder(): {
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

export const BASE_UPSERT_GATES = [
  "V2 base upsert has no remote file identity: note.md",
  "V2 base upsert remote version mismatch: note.md",
  "V2 base upsert would replace another anchor: note.md",
];

export const makeStaleTreeCommitProbe = async (decide: (
  attempt: number,
) => "reject" | "succeed") => {
  const uploadedContent = new Uint8Array([1, 2, 3]).buffer;
  const uploadedHash = await sha256Hex(uploadedContent);
  const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
  const remote: RemoteFileEntry = {
    path: "note.md",
    driveId: "uploaded-note",
    parentId: activeScope.filesRootId,
    size: uploadedContent.byteLength,
    mtime: 3,
    eTag: "etag-uploaded",
    cTag: "ctag-uploaded",
    sha256Hash: uploadedHash,
  };
  const state = makeActiveV2State([remote], [], {
    mutationLedger: [{
      intent: {
        version: 1,
        operationId: "op-stale-tree",
        planRevision: 1,
        scope: activeScope,
        action: "upload",
        path: remote.path,
        expectedLocal: {
          exists: true,
          hash: uploadedHash,
          size: uploadedContent.byteLength,
        },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "op-stale-tree",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: remote.path,
            hash: uploadedHash,
            size: uploadedContent.byteLength,
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
  vi.mocked(state.retireMutationCheckpointIfReflected).mockResolvedValue(false);
  const realCommit = state.commitMutationCheckpoint;
  let attempts = 0;
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    attempts++;
    if (decide(attempts) === "reject") {
      throw new Error(BASE_UPSERT_GATES[0]);
    }
    return realCommit(operationId);
  }) as never;
  const executor = new SyncExecutor(
    makeMockOneDrive({
      getFileMetadata: vi.fn().mockResolvedValue(remote),
    }),
    Object.assign(emptyScanner(), {
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: {
          path: remote.path,
          hash: "cd".repeat(32),
          size: 4,
          mtime: 9,
          binary: false,
        },
      }),
    }),
    state,
    "testVault",
  );
  const rebuild = vi.fn().mockResolvedValue([]);
  (executor as unknown as { rebuildRemoteStateFromIdentitySnapshot: unknown })
    .rebuildRemoteStateFromIdentitySnapshot = rebuild;
  // A round sets the active scope before the recovery runs; a direct call
  // must do the same or the repair has no scope to rebuild (fail-closed).
  (executor as unknown as { activeSyncScope: SyncScope })
    .activeSyncScope = activeScope;
  return { executor, state, activeScope, rebuild, attempts: () => attempts };
};
