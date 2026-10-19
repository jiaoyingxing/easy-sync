// V2 激活测试的共享夹具与帮手（原 tests/state-v2-activation.test.ts 前置块）。
// 拆分后由各 state-v2-*.test.ts 导入。
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Platform, TFile, TFolder, type DataAdapter } from "obsidian";
import EasySyncPlugin, {
  type DeferredSettingsMutationHandle,
} from "../../src/main";
import type { OneDriveClient } from "../../src/onedrive/client";
import {
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
  SharedSyncProtocolObservationError,
  SyntheticRequestTimeoutError,
  type DriveItem,
} from "../../src/onedrive/types";
import { sha256Hex } from "../../src/crypto";
import {
  getEasySyncLegacyPaths,
  getEasySyncPaths,
} from "../../src/obsidian-compat";
import {
  createFolderSyncScopeSnapshotV1,
  isFolderPathInSyncScopeSnapshot,
  LocalScanner,
} from "../../src/sync/local-scanner";
import { projectStatePathViewV2 } from "../../src/sync/file-state-controller-v2";
import type { ManualResolutionEntrySnapshot } from "../../src/sync/manual-resolution-entry";
import { StateManager, type PluginDataStore } from "../../src/sync/state-manager";
import {
  SyncExecutor,
  type SyncCallbacks,
  type SyncMode,
  type SyncResult,
  type SyncRunOptions,
} from "../../src/sync/sync-executor";
import { buildCommunityPluginInventory } from "../../src/sync/community-plugin-inventory";
import { buildRemoteCommunityPluginCatalog } from "../../src/sync/community-plugin-remote-catalog";
import { isPluginSelected } from "../../src/sync/community-plugin-sync-policy";
import type { SyncStateEnvelopeV2 } from "../../src/sync/state-envelope-v2";
import { ConfigSyncModal } from "../../src/ui/config-sync-modal";
import { SequentialSettingsUpdateQueue } from "../../src/ui/sequential-settings-update-queue";
import { canonicalPlanDigestV2 } from "../../src/sync/canonical-plan-v2";
import { KEY_PUBLIC_113_CUTOVER } from "../../src/sync/public-1-1-3-cutover";
import {
  IndexedDbPublic113StateStore,
  type Public113IndexedDbCandidateStoreFactory,
} from "../../src/sync/indexeddb-public-1-1-3-state";
import { StateV2IndexedDbActiveStore, stateV2ActiveIndexedDbDatabaseName } from "../../src/sync/state-v2-indexeddb-active";
import { openDB } from "idb";
import {
  IndexedDbRemoteScopeRecoveryEvidenceStore,
} from "../../src/sync/remote-scope-recovery-evidence-store";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "../../src/sync/state-v2-indexeddb-recovery";
import { ensureSharedSyncProtocolV3 } from "../../src/sync/sync-protocol-v3";
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
} from "../../src/sync/types";
import { injectActiveCommitCompletionFault } from "./indexeddb-completion-fault";

export const paths = getEasySyncPaths(".obsidian");
export const legacyPaths = getEasySyncLegacyPaths(".obsidian");
export const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
export const hashA = "a".repeat(64);
export const protocolBinding = {
  schemaVersion: 1 as const,
  protocolVersion: 2 as const,
  migrationGeneration: "a".repeat(64),
  confirmedAllDevicesUpdatedAt: 1,
  recordId: "protocol-id",
  recordETag: "protocol-etag",
};
export const hashB = "b".repeat(64);
export const localA: LocalFileEntry = {
  path: "Notes/a.md",
  size: 10,
  mtime: 1,
  hash: hashA,
  binary: false,
};
export const baseA: BaseFileEntry = {
  path: localA.path,
  hash: localA.hash,
  size: localA.size,
  eTag: "etag-a",
};
export const communityPluginPath = ".obsidian/community-plugins.json";
export let harnessVaultInstanceSequence = 0;

export interface ActivationTestRunOptions extends SyncRunOptions {
  /**
   * Test-only convenience: exercise the real two-round production migration
   * transaction and return the confirmation result for an exact zero plan.
   * It never enters the production SyncExecutor API or bundle.
   */
  activateV2State?: true;
}

export class V2ActivationTestExecutor extends SyncExecutor {
  private confirmReviewedMigrationForTest = false;
  private readonly initialActivationFolderPaths: Set<string>;

  constructor(
    client: ConstructorParameters<typeof SyncExecutor>[0],
    scanner: ConstructorParameters<typeof SyncExecutor>[1],
    private readonly activationState: StateManager,
    vaultName: ConstructorParameters<typeof SyncExecutor>[3],
    diag: ConstructorParameters<typeof SyncExecutor>[6],
    fileManager: ConstructorParameters<typeof SyncExecutor>[7],
    private readonly activationFolderPaths: Set<string>,
  ) {
    super(
      client,
      scanner,
      activationState,
      vaultName,
      undefined,
      undefined,
      diag,
      fileManager,
    );
    this.initialActivationFolderPaths = new Set(activationFolderPaths);
  }

  override async run(
    mode: SyncMode,
    callbacks: SyncCallbacks = {},
    skipConfirmation = false,
    reviewedAuthorization?: PlanReviewAuthorization,
    options: ActivationTestRunOptions = {},
  ): Promise<SyncResult> {
    const {
      activateV2State = false,
      ...productionOptions
    } = options;
    if (activateV2State) {
      this.confirmReviewedMigrationForTest = true;
      // The broad folder double exposes adapter-created EasySync internals.
      // Production LocalScanner excludes those descendants; preserve config
      // folders that the individual test supplied as real vault input.
      for (const folder of [...this.activationFolderPaths]) {
        if (
          folder.startsWith(".obsidian")
          && !this.initialActivationFolderPaths.has(folder)
        ) {
          this.activationFolderPaths.delete(folder);
        }
      }
    }
    const effectiveProductionOptions =
      this.confirmReviewedMigrationForTest
      && skipConfirmation
      && reviewedAuthorization?.reviewKind === "v2-migration"
        ? {
            ...productionOptions,
            acknowledgeMigrationRisk: true,
          }
        : productionOptions;
    const resumableConfirmedHold =
      activateV2State
      && this.activationState.activeV2MigrationHold?.phase === "confirmed"
      && this.activationState.planReviewAuthorization?.reviewKind
        === "v2-migration";
    if (resumableConfirmedHold) {
      return super.run(
        mode,
        {},
        true,
        this.activationState.planReviewAuthorization!,
        productionOptions,
      );
    }
    let firstSyncPreviewAccepted: boolean | undefined;
    const productionCallbacks = activateV2State
      && mode === "first"
      && callbacks.onFirstSyncPreview
      ? {
          ...callbacks,
          onFirstSyncPreview: async (plan: SyncPlan) => {
            firstSyncPreviewAccepted =
              await callbacks.onFirstSyncPreview!(plan);
            return firstSyncPreviewAccepted;
          },
        }
      : callbacks;
    const first = await super.run(
      mode,
      productionCallbacks,
      skipConfirmation,
      reviewedAuthorization,
      effectiveProductionOptions,
    );
    if (!activateV2State) return first;

    const authorization = this.activationState.planReviewAuthorization;
    const hold = this.activationState.activeV2MigrationHold;
    const exactZeroPlanAwaitingConfirmation = Boolean(
      first.message === "result.pausedForReview"
      && !this.activationState.isV2StateActive
      && authorization?.reviewKind === "v2-migration"
      && hold?.phase === "pending"
      && hold.items.length === 0
      && (
        mode !== "first"
        || callbacks.onFirstSyncPreview === undefined
        || firstSyncPreviewAccepted === true
      ),
    );
    if (!exactZeroPlanAwaitingConfirmation) return first;

    // Ancestor preparation can expose another synthetic internal directory
    // between preview and confirmation, so normalize the second scan too.
    for (const folder of [...this.activationFolderPaths]) {
      if (
        folder.startsWith(".obsidian")
        && !this.initialActivationFolderPaths.has(folder)
      ) {
        this.activationFolderPaths.delete(folder);
      }
    }
    return super.run(
      mode,
      {},
      true,
      authorization,
      {
        ...effectiveProductionOptions,
        acknowledgeMigrationRisk: true,
      },
    );
  }
}

export function remoteItems(hash = hashA): DriveItem[] {
  return [
    {
      id: "folder-notes",
      name: "Notes",
      folder: { childCount: 1 },
      parentReference: { id: scope.filesRootId },
      eTag: "etag-folder-notes",
      cTag: "ctag-folder-notes",
    },
    {
      id: "file-a",
      name: "a.md",
      size: localA.size,
      file: { hashes: { sha256Hash: hash } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-a",
      cTag: "ctag-a",
    },
  ];
}

export function remoteItemsWithCommunityPluginState(
  contentHash: string,
  size: number,
): DriveItem[] {
  return [
    ...remoteItems(),
    {
      id: "folder-obsidian",
      name: ".obsidian",
      folder: { childCount: 1 },
      parentReference: { id: scope.filesRootId },
      eTag: "etag-folder-obsidian",
    },
    {
      id: "file-community-plugins",
      name: "community-plugins.json",
      size,
      file: { hashes: { sha256Hash: contentHash } },
      parentReference: { id: "folder-obsidian" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-community-plugins",
      cTag: "ctag-community-plugins",
    },
  ];
}

export async function sharedCalendarPluginBundleFixture() {
  const rootPath = ".obsidian/plugins/calendar";
  const mainPath = `${rootPath}/main.js`;
  const manifestPath = `${rootPath}/manifest.json`;
  const mainContent = "calendar-main";
  const manifestContent = JSON.stringify({
    id: "calendar",
    name: "Calendar",
    version: "1.0.0",
    minAppVersion: "1.5.0",
  });
  const mainBytes = new TextEncoder().encode(mainContent);
  const manifestBytes = new TextEncoder().encode(manifestContent);
  const mainHash = await sha256Hex(mainBytes);
  const manifestHash = await sha256Hex(manifestBytes);
  const local: LocalFileEntry[] = [
    {
      path: mainPath,
      size: mainBytes.byteLength,
      mtime: 1,
      hash: mainHash,
      binary: false,
    },
    {
      path: manifestPath,
      size: manifestBytes.byteLength,
      mtime: 1,
      hash: manifestHash,
      binary: false,
    },
  ];
  const base: BaseFileEntry[] = [
    {
      path: mainPath,
      size: mainBytes.byteLength,
      hash: mainHash,
      eTag: "etag-calendar-main",
    },
    {
      path: manifestPath,
      size: manifestBytes.byteLength,
      hash: manifestHash,
      eTag: "etag-calendar-manifest",
    },
  ];
  const remoteItems: DriveItem[] = [
    {
      id: "folder-community-plugins",
      name: "plugins",
      folder: { childCount: 1 },
      parentReference: { id: "folder-obsidian" },
      eTag: "etag-folder-community-plugins",
    },
    {
      id: "folder-calendar",
      name: "calendar",
      folder: { childCount: 2 },
      parentReference: { id: "folder-community-plugins" },
      eTag: "etag-folder-calendar",
    },
    {
      id: "file-calendar-main",
      name: "main.js",
      size: mainBytes.byteLength,
      file: { hashes: { sha256Hash: mainHash } },
      parentReference: { id: "folder-calendar" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-calendar-main",
      cTag: "ctag-calendar-main",
    },
    {
      id: "file-calendar-manifest",
      name: "manifest.json",
      size: manifestBytes.byteLength,
      file: { hashes: { sha256Hash: manifestHash } },
      parentReference: { id: "folder-calendar" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-calendar-manifest",
      cTag: "ctag-calendar-manifest",
    },
  ];
  return {
    local,
    base,
    localFolders: [
      { path: ".obsidian/plugins" },
      { path: rootPath },
    ],
    remoteItems,
    initialFiles: {
      [mainPath]: mainContent,
      [manifestPath]: manifestContent,
    },
    remoteFileContents: {
      [mainPath]: mainContent,
      [manifestPath]: manifestContent,
    },
  };
}

export function remoteFolderTree(
  folderPaths: readonly string[],
): DriveItem[] {
  const idByPath = new Map<string, string>();
  return [...folderPaths]
    .sort((left, right) =>
      left.split("/").length - right.split("/").length
      || left.localeCompare(right))
    .map((path, index) => {
      const parent = parentPath(path);
      const id = `scope-folder-${index + 1}`;
      idByPath.set(path, id);
      return {
        id,
        name: path.slice(path.lastIndexOf("/") + 1),
        folder: {},
        parentReference: {
          id: parent ? idByPath.get(parent)! : scope.filesRootId,
        },
        eTag: `scope-folder-etag-${index + 1}`,
      };
    });
}

export function findRemoteItemByPath(
  items: readonly DriveItem[],
  targetPath: string,
): DriveItem | null {
  const byId = new Map(items.map((item) => [item.id, item]));
  const pathFor = (item: DriveItem): string | null => {
    const segments = [item.name];
    let parentId = item.parentReference?.id;
    const visited = new Set<string>([item.id]);
    while (parentId && parentId !== scope.filesRootId) {
      if (visited.has(parentId)) return null;
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent?.folder) return null;
      segments.unshift(parent.name);
      parentId = parent.parentReference?.id;
    }
    return parentId === scope.filesRootId ? segments.join("/") : null;
  };
  return items.find((item) => pathFor(item) === targetPath) ?? null;
}

export function applyRemoteUpload(
  items: DriveItem[],
  targetPath: string,
  size: number,
  hash: string,
  eTag: string,
): DriveItem {
  const remote = findRemoteItemByPath(items, targetPath)!;
  remote.size = size;
  remote.file = { hashes: { sha256Hash: hash } };
  remote.eTag = eTag;
  remote.cTag = `ctag-${eTag}`;
  return { ...remote, parentReference: { ...remote.parentReference } };
}

export function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function makeHarness(input?: {
  base?: BaseFileEntry[];
  local?: LocalFileEntry[];
  localFolders?: Array<{ path: string }>;
  remoteHash?: string;
  remoteItems?: DriveItem[];
  initialFiles?: Record<string, string>;
  remoteFileContents?: Record<string, string>;
  pluginData?: Record<string, unknown>;
  folderScanComplete?: boolean;
  folderScanFailures?: string[];
  enableCloudBootstrap?: boolean;
  createPublic113IndexedDbCandidateStore?:
    Public113IndexedDbCandidateStoreFactory;
  indexedDbVaultInstanceId?: string;
  createStateV2IndexedDbActiveStore?:
    PluginDataStore["createStateV2IndexedDbActiveStore"];
}) {
  const files = new Map<string, string>(
    Object.entries(input?.initialFiles ?? {}),
  );
  const localEntryState = [
    ...(input?.local ?? [localA]),
  ].map((entry) => ({ ...entry }));
  const localFolderPaths = new Set(
    (input?.localFolders ?? [{ path: "Notes" }]).map((folder) => folder.path),
  );
  const remoteItemState = [
    ...(input?.remoteItems ?? remoteItems(input?.remoteHash)),
  ];
  const pluginData: Record<string, unknown> = {
    "easy-sync-base-snapshot": Object.fromEntries(
      (input?.base ?? [baseA]).map((entry) => [entry.path, entry]),
    ),
    "easy-sync-bound-account": scope.accountId,
    "easy-sync-generation": 7,
    ...input?.pluginData,
  };
  let failNextManifestRename = false;
  let failNextManifestStagingRemove = false;
  let commitNextManifestThenThrow = false;
  let loseNextV1BackupWriteResponse = false;
  let loseNextManifestStagedWriteResponse = false;
  let failNextManifestCommittedRead = false;
  let failNextAncestorManifestRename = false;
  let failNextStateRename = false;
  let failNextAuthorityWitnessWrite = false;
  let loseNextAuthorityWitnessWriteResponse = false;
  let loseNextAuthorityWitnessCommittedWriteResponse = false;
  let failNextHoldAuthorityRename = false;
  let failNextHoldCompletionWrite = false;
  let failNextHoldCompletionRename = false;
  let loseNextHoldAuthorityRenameResponse = false;
  let loseNextHoldCompletionWriteResponse = false;
  let loseNextHoldCompletionRenameResponse = false;
  let loseNextFolderCreateResponse = false;
  let loseNextFolderMoveResponse = false;
  let loseNextFolderDeleteResponse = false;
  let loseNextLocalFolderCreateResponse = false;
  let loseNextLocalFolderMoveResponse = false;
  let loseNextLocalFolderDeleteResponse = false;
  let loseNextLocalFileMoveResponse = false;
  let loseNextLocalFileDeleteResponse = false;
  let failNextTrash = false;
  let conflictNextFolderDelete = false;
  let conflictNextFolderMove = false;
  let changeNextParentVersion = false;
  let moveNextParent = false;
  let onNextDelta: (() => void) | null = null;
  /** 宿主写入面与适配器写入落同一份事实；分开是为了让 rawAdapter.writeBinary 的
   *  调用记录只反映生产代码直接对适配器的写入（真实 vault.modify 不走那条路）。 */
  const hostWrites: string[] = [];
  const commitLocalBytes = async (path: string, value: ArrayBuffer) => {
    const content = new Uint8Array(value);
    files.set(path, new TextDecoder().decode(content));
    const current = localEntryState.find((entry) => entry.path === path);
    const next = {
      path,
      size: content.byteLength,
      mtime: (current?.mtime ?? 0) + 1,
      hash: await sha256Hex(content),
      binary: false,
    };
    if (current) Object.assign(current, next);
    else localEntryState.push(next);
  };
  const rawAdapter = {
    exists: vi.fn(async (path: string) => files.has(path) || localFolderPaths.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      if (
        failNextManifestCommittedRead
        && path === paths.stateV2ManifestFile
      ) {
        failNextManifestCommittedRead = false;
        throw new Error("manifest committed read-back interrupted");
      }
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      if (
        failNextAuthorityWitnessWrite
        && path === paths.stateV2AuthorityWitnessNextFile
      ) {
        failNextAuthorityWitnessWrite = false;
        throw new Error("authority witness write interrupted");
      }
      if (
        loseNextV1BackupWriteResponse
        && path === paths.stateV1BackupFile
      ) {
        loseNextV1BackupWriteResponse = false;
        files.set(path, value);
        throw new Error("V1 backup write response lost");
      }
      if (
        loseNextManifestStagedWriteResponse
        && path === paths.stateV2ManifestNextFile
      ) {
        loseNextManifestStagedWriteResponse = false;
        files.set(path, value);
        throw new Error("manifest staged write response lost");
      }
      if (
        loseNextAuthorityWitnessWriteResponse
        && path === paths.stateV2AuthorityWitnessNextFile
      ) {
        loseNextAuthorityWitnessWriteResponse = false;
        files.set(path, value);
        throw new Error("authority witness write response lost");
      }
      if (
        loseNextAuthorityWitnessCommittedWriteResponse
        && path === paths.stateV2AuthorityWitnessFile
      ) {
        loseNextAuthorityWitnessCommittedWriteResponse = false;
        files.set(path, value);
        throw new Error("authority witness committed write response lost");
      }
      if (
        failNextHoldCompletionWrite
        && path === paths.stateV2MigrationHoldNextFile
        && (JSON.parse(value) as { phase?: string }).phase === "completed"
      ) {
        failNextHoldCompletionWrite = false;
        throw new Error("migration hold completion write interrupted");
      }
      if (
        loseNextHoldCompletionWriteResponse
        && path === paths.stateV2MigrationHoldNextFile
        && (JSON.parse(value) as { phase?: string }).phase === "completed"
      ) {
        loseNextHoldCompletionWriteResponse = false;
        files.set(path, value);
        throw new Error("migration hold completion write response lost");
      }
      files.set(path, value);
    }),
    process: vi.fn(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      const next = fn(value);
      files.set(path, next);
      return next;
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
      const entryIndex = localEntryState.findIndex((entry) => entry.path === path);
      if (entryIndex >= 0) localEntryState.splice(entryIndex, 1);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (
        commitNextManifestThenThrow
        && from === paths.stateV2ManifestNextFile
        && to === paths.stateV2ManifestFile
      ) {
        commitNextManifestThenThrow = false;
        const value = files.get(from);
        if (value === undefined) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, value);
        throw new Error("manifest rename response lost");
      }
      if (
        failNextManifestRename
        && from === paths.stateV2ManifestNextFile
        && to === paths.stateV2ManifestFile
      ) {
        failNextManifestRename = false;
        throw new Error("manifest rename interrupted");
      }
      if (
        failNextStateRename
        && from === paths.stateV2NextFile
        && to === paths.stateV2File
      ) {
        failNextStateRename = false;
        throw new Error("state rename interrupted");
      }
      if (
        from === paths.stateV2MigrationHoldNextFile
        && to === paths.stateV2MigrationHoldFile
      ) {
        const staged = files.get(from);
        const phase = staged
          ? (JSON.parse(staged) as { phase?: string }).phase
          : undefined;
        if (failNextHoldAuthorityRename && phase === "authority-committed") {
          failNextHoldAuthorityRename = false;
          throw new Error("migration hold authority transition interrupted");
        }
        if (failNextHoldCompletionRename && phase === "completed") {
          failNextHoldCompletionRename = false;
          throw new Error("migration hold completion interrupted");
        }
        if (
          loseNextHoldAuthorityRenameResponse
          && phase === "authority-committed"
        ) {
          loseNextHoldAuthorityRenameResponse = false;
          files.delete(from);
          files.set(to, staged!);
          throw new Error("migration hold authority rename response lost");
        }
        if (
          loseNextHoldCompletionRenameResponse
          && phase === "completed"
        ) {
          loseNextHoldCompletionRenameResponse = false;
          files.delete(from);
          files.set(to, staged!);
          throw new Error("migration hold completion rename response lost");
        }
      }
      if (
        failNextAncestorManifestRename
        && from === paths.ancestorManifestV2NextFile
        && to === paths.ancestorManifestV2File
      ) {
        failNextAncestorManifestRename = false;
        throw new Error("ancestor manifest rename interrupted");
      }
      const value = files.get(from);
      if (value !== undefined) {
        files.delete(from);
        files.set(to, value);
        const entry = localEntryState.find((candidate) => candidate.path === from);
        let replaced: LocalFileEntry | undefined;
        if (entry) {
          const replacedIndex = localEntryState.findIndex(
            (candidate) => candidate !== entry && candidate.path === to,
          );
          if (replacedIndex >= 0) localEntryState.splice(replacedIndex, 1);
          entry.path = to;
          replaced = entry;
        } else {
          replaced = localEntryState.find((candidate) => candidate.path === to);
        }
        if (!replaced) {
          const recovery = localEntryState.find(
            (candidate) => candidate.path === `${to}.easy-sync-recovery`,
          );
          if (recovery) {
            replaced = {
              ...recovery,
              path: to,
            };
            localEntryState.push(replaced);
          }
        }
        if (replaced) {
          const bytes = new TextEncoder().encode(value);
          replaced.hash = await sha256Hex(bytes);
          replaced.size = bytes.byteLength;
          replaced.mtime++;
        }
        return;
      }
      if (localFolderPaths.has(from)) {
        const folders = [...localFolderPaths]
          .filter((path) => path === from || path.startsWith(`${from}/`));
        for (const path of folders) localFolderPaths.delete(path);
        for (const path of folders) {
          localFolderPaths.add(path === from ? to : `${to}${path.slice(from.length)}`);
        }
        for (const entry of localEntryState) {
          if (entry.path.startsWith(`${from}/`)) {
            entry.path = `${to}${entry.path.slice(from.length)}`;
          }
        }
        return;
      }
      throw new Error(`missing ${from}`);
    }),
    mkdir: vi.fn(async (path: string) => {
      localFolderPaths.add(path);
    }),
    rmdir: vi.fn(async (path: string, recursive = false) => {
      if (recursive) {
        for (const file of [...files.keys()]) {
          if (file.startsWith(`${path}/`)) files.delete(file);
        }
        for (const folder of [...localFolderPaths]) {
          if (folder === path || folder.startsWith(`${path}/`)) {
            localFolderPaths.delete(folder);
          }
        }
        return;
      }
      localFolderPaths.delete(path);
    }),
    stat: vi.fn(async (path: string) => localFolderPaths.has(path)
      ? { type: "folder", ctime: 1, mtime: 1, size: 0 }
      : files.has(path)
        ? { type: "file", ctime: 1, mtime: 1, size: files.get(path)!.length }
        : localEntryState.some((entry) => entry.path === path)
          ? {
              type: "file",
              ctime: 1,
              mtime: 1,
              size: localEntryState.find((entry) => entry.path === path)!.size,
            }
        : null),
    list: vi.fn(async (path: string) => ({
      files: [...new Set([
        ...localEntryState
          .filter((entry) => parentPath(entry.path) === path)
          .map((entry) => entry.path),
        ...[...files.keys()].filter((entry) => parentPath(entry) === path),
      ])],
      folders: [...localFolderPaths]
        .filter((folder) => parentPath(folder) === path)
        .sort(),
    })),
    readBinary: vi.fn(async (path: string) =>
      new TextEncoder().encode(files.get(path) ?? "").buffer),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      await commitLocalBytes(path, value);
    }),
  };
  const adapter = rawAdapter as unknown as DataAdapter;
  const indexedDbVaultInstanceId = input?.indexedDbVaultInstanceId
    ?? (++harnessVaultInstanceSequence).toString(16).padStart(32, "0");
  const plugin: PluginDataStore = {
    loadData: vi.fn(async () => pluginData),
    updatePluginData: vi.fn(async (mutator) => mutator(pluginData)),
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "easy-sync", dir: paths.pluginDir },
    indexedDbVaultInstanceId,
    createRemoteScopeRecoveryEvidenceStore: (vaultInstanceId) =>
      new IndexedDbRemoteScopeRecoveryEvidenceStore(vaultInstanceId),
    ...(input?.createPublic113IndexedDbCandidateStore
      ? {
          createPublic113IndexedDbCandidateStore:
            input.createPublic113IndexedDbCandidateStore,
        }
      : {}),
    ...(input?.createStateV2IndexedDbActiveStore
      ? {
          createStateV2IndexedDbActiveStore:
            input.createStateV2IndexedDbActiveStore,
        }
      : {}),
  };
  const scanner = {
    vault: {
      adapter,
      configDir: ".obsidian",
      getFiles: vi.fn().mockReturnValue([]),
      getAllLoadedFiles: vi.fn(() =>
        [...localFolderPaths].map((path) => new TFolder(path))),
      getAbstractFileByPath: vi.fn((path: string) =>
        localFolderPaths.has(path)
          ? new TFolder(path)
          : localEntryState.some((entry) => entry.path === path)
            ? new TFile(path)
            : null),
      getFileByPath: vi.fn((path: string) =>
        // 配置目录里的文件在真实宿主里不在库索引中（`getFileByPath` 返回 null），
        // 永远走原子替换——假体也按这条路由，别让配置路径假装成宿主可见文件。
        !path.startsWith(".obsidian/")
        && localEntryState.some((entry) => entry.path === path)
          ? new TFile(path)
          : null),
      // 真实宿主总是自带的写入面：有它才会走「原地写」而不是改名交换
      // （`DECISIONS` 2026-09-23 第 9 点）。
      modify: vi.fn(async (file: TFile, data: string) => {
        hostWrites.push(data);
        await commitLocalBytes(file.path, new TextEncoder().encode(data).buffer);
      }),
      createFolder: vi.fn(async (path: string) => {
        localFolderPaths.add(path);
        if (loseNextLocalFolderCreateResponse) {
          loseNextLocalFolderCreateResponse = false;
          throw new Error("local folder create response lost");
        }
      }),
      rename: vi.fn(async (file: TFile | TFolder, targetPath: string) => {
        const sourcePath = file.path;
        if (file instanceof TFolder) {
          const folders = [...localFolderPaths]
            .filter((path) => path === sourcePath || path.startsWith(`${sourcePath}/`));
          for (const path of folders) localFolderPaths.delete(path);
          for (const path of folders) {
            localFolderPaths.add(
              path === sourcePath ? targetPath : `${targetPath}${path.slice(sourcePath.length)}`,
            );
          }
          for (const entry of localEntryState) {
            if (entry.path.startsWith(`${sourcePath}/`)) {
              entry.path = `${targetPath}${entry.path.slice(sourcePath.length)}`;
            }
          }
          for (const [path, content] of [...files]) {
            if (!path.startsWith(`${sourcePath}/`)) continue;
            files.delete(path);
            files.set(`${targetPath}${path.slice(sourcePath.length)}`, content);
          }
          if (loseNextLocalFolderMoveResponse) {
            loseNextLocalFolderMoveResponse = false;
            throw new Error("local folder move response lost");
          }
          return;
        }
        const entry = localEntryState.find((candidate) => candidate.path === sourcePath);
        if (!entry) throw new Error(`missing ${sourcePath}`);
        entry.path = targetPath;
        if (loseNextLocalFileMoveResponse) {
          loseNextLocalFileMoveResponse = false;
          throw new Error("local file move response lost");
        }
      }),
      getName: vi.fn().mockReturnValue("testVault"),
    },
    scanAll: vi.fn(async () => ({
      entries: localEntryState.map((entry) => ({ ...entry })),
      folders: [...localFolderPaths]
        .filter((path) => !path.startsWith(paths.pluginDirPrefix))
        .sort()
        .map((path) => ({ path })),
      folderScanComplete: input?.folderScanComplete ?? true,
      folderScanFailures: input?.folderScanFailures ?? [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    })),
    scanFile: vi.fn().mockResolvedValue(null),
    inspectFile: vi.fn(async (path: string) => {
      const entry = localEntryState.find((candidate) => candidate.path === path);
      return entry
        ? { status: "present" as const, entry: { ...entry } }
        : { status: "missing" as const };
    }),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
  } as unknown as LocalScanner;
  const mutations = {
    uploadFile: vi.fn().mockResolvedValue({
      id: "uploaded-file",
      eTag: "etag-uploaded",
      size: 0,
      parentReference: { id: scope.filesRootId },
    }),
    downloadFile: vi.fn(async (_vaultName: string, path: string) => {
      const content = input?.remoteFileContents?.[path];
      return content === undefined
        ? new ArrayBuffer(0)
        : new TextEncoder().encode(content).buffer;
    }),
    downloadFileToPath: vi.fn(),
    deleteItem: vi.fn(async (
      _vaultName: string,
      _path: string,
      eTag?: string,
      driveItemId?: string,
    ) => {
      const index = remoteItemState.findIndex((item) => item.id === driveItemId);
      if (index < 0) return;
      if (conflictNextFolderDelete) {
        conflictNextFolderDelete = false;
        throw new OneDriveError(
          OneDriveErrorType.PreconditionFailed,
          "folder changed",
          412,
        );
      }
      if (
        eTag
        && remoteItemState[index].eTag !== eTag
        && remoteItemState[index].cTag !== eTag
      ) {
        throw new Error("delete precondition failed");
      }
      const deletedIds = new Set([remoteItemState[index].id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of remoteItemState) {
          if (
            item.parentReference?.id
            && deletedIds.has(item.parentReference.id)
            && !deletedIds.has(item.id)
          ) {
            deletedIds.add(item.id);
            expanded = true;
          }
        }
      }
      for (let itemIndex = remoteItemState.length - 1; itemIndex >= 0; itemIndex--) {
        if (deletedIds.has(remoteItemState[itemIndex].id)) {
          remoteItemState.splice(itemIndex, 1);
        }
      }
      if (loseNextFolderDeleteResponse) {
        loseNextFolderDeleteResponse = false;
        throw new Error("folder delete response lost");
      }
    }),
    renameItem: vi.fn(),
    moveItemById: vi.fn(async (
      driveItemId: string,
      eTag: string,
      name: string,
      parentDriveItemId: string,
    ) => {
      const item = remoteItemState.find((candidate) => candidate.id === driveItemId);
      if (!item || item.eTag !== eTag) throw new Error("move precondition failed");
      if (conflictNextFolderMove) {
        conflictNextFolderMove = false;
        item.eTag = `${eTag}-advanced`;
        throw new OneDriveError(
          OneDriveErrorType.PreconditionFailed,
          "folder changed",
          412,
        );
      }
      item.name = name;
      item.parentReference = { id: parentDriveItemId };
      item.eTag = `${eTag}-moved`;
      if (loseNextFolderMoveResponse) {
        loseNextFolderMoveResponse = false;
        throw new Error("folder move response lost");
      }
      return item;
    }),
  };
  const getDelta = vi.fn().mockImplementation(async () => {
    const callback = onNextDelta;
    onNextDelta = null;
    callback?.();
    return {
      value: [...remoteItemState],
      "@odata.deltaLink": "https://graph.example/delta-current",
    };
  });
  let cloudBootstrapObject: { id: string; eTag: string; content: string } | null = null;
  let sharedProtocolObject: {
    id: string;
    eTag: string;
    content: string;
  } | null = null;
  let sharedProtocolCreateCount = 0;
  let sharedProtocolV3Object: {
    id: string;
    eTag: string;
    content: string;
  } | null = null;
  let sharedProtocolV3CreateCount = 0;
  const readSharedSyncProtocolV2 = vi.fn(async () => sharedProtocolObject);
  const readSharedSyncProtocolV3 = vi.fn(async () => sharedProtocolV3Object);
  const cloudBootstrap = {
    read: vi.fn(async () => cloudBootstrapObject),
    create: vi.fn(async (_vaultName: string, content: string) => {
      cloudBootstrapObject = {
        id: "bootstrap-id",
        eTag: "bootstrap-etag-1",
        content,
      };
      return {
        id: cloudBootstrapObject.id,
        eTag: cloudBootstrapObject.eTag,
      };
    }),
    update: vi.fn(async (id: string, eTag: string, content: string) => {
      if (!cloudBootstrapObject
        || cloudBootstrapObject.id !== id
        || cloudBootstrapObject.eTag !== eTag) {
        throw new Error("bootstrap precondition failed");
      }
      const revision = JSON.parse(content).revision;
      cloudBootstrapObject = {
        id,
        eTag: `bootstrap-etag-${revision}`,
        content,
      };
      return { id, eTag: cloudBootstrapObject.eTag };
    }),
    readById: vi.fn(async (id: string) => {
      if (!cloudBootstrapObject || cloudBootstrapObject.id !== id) {
        throw new Error("bootstrap missing");
      }
      return cloudBootstrapObject;
    }),
  };
  const client = {
    downloadBaseline: vi.fn().mockResolvedValue(null),
    initVaultScope: vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    }),
    restoreVaultScope: vi.fn().mockReturnValue(false),
    invalidateVaultScope: vi.fn(),
    isDeltaLinkForVault: vi.fn().mockReturnValue(true),
    setAbortSignal: vi.fn(),
    resetDownloadStrategy: vi.fn(),
    getDelta,
    getDeltaByFolderId: getDelta,
    readSharedSyncProtocolV2,
    createSharedSyncProtocolV2: vi.fn(async (
      _vaultName: string,
      content: string,
    ) => {
      if (sharedProtocolObject) throw new Error("protocol conflict");
      sharedProtocolCreateCount++;
      sharedProtocolObject = {
        id: sharedProtocolCreateCount === 1
          ? "protocol-id"
          : `protocol-id-${sharedProtocolCreateCount}`,
        eTag: "protocol-etag",
        content,
      };
      return {
        id: sharedProtocolObject.id,
        eTag: sharedProtocolObject.eTag,
      };
    }),
    readSharedSyncProtocolV2ById: vi.fn(async (id: string) => {
      if (!sharedProtocolObject || sharedProtocolObject.id !== id) {
        throw new Error("protocol missing");
      }
      return sharedProtocolObject;
    }),
    overwriteSharedSyncProtocolV2: vi.fn(async (
      id: string,
      eTag: string,
      content: string,
    ) => {
      if (
        !sharedProtocolObject
        || sharedProtocolObject.id !== id
        || sharedProtocolObject.eTag !== eTag
      ) {
        throw new Error("protocol overwrite conflict");
      }
      sharedProtocolObject = {
        id,
        eTag: `${eTag}-overwritten`,
        content,
      };
      return { id, eTag: sharedProtocolObject.eTag };
    }),
    readSharedSyncProtocolV3,
    readSharedSyncProtocolObjects: vi.fn(async (vaultName: string) => {
      const [v2, v3] = await Promise.all([
        readSharedSyncProtocolV2(vaultName),
        readSharedSyncProtocolV3(vaultName),
      ]);
      return { v2, v3 };
    }),
    createSharedSyncProtocolV3: vi.fn(async (
      _vaultName: string,
      content: string,
    ) => {
      if (sharedProtocolV3Object) throw new Error("protocol conflict");
      sharedProtocolV3CreateCount++;
      sharedProtocolV3Object = {
        id: sharedProtocolV3CreateCount === 1
          ? "protocol-v3-id"
          : `protocol-v3-id-${sharedProtocolV3CreateCount}`,
        eTag: "protocol-v3-etag",
        content,
      };
      return {
        id: sharedProtocolV3Object.id,
        eTag: sharedProtocolV3Object.eTag,
      };
    }),
    readSharedSyncProtocolV3ById: vi.fn(async (id: string) => {
      if (!sharedProtocolV3Object || sharedProtocolV3Object.id !== id) {
        throw new Error("protocol missing");
      }
      return sharedProtocolV3Object;
    }),
    fullScan: vi.fn(async () => [...remoteItemState]),
    getFileMetadata: vi.fn(async (_vaultName: string, path: string) => {
      const item = findRemoteItemByPath(remoteItemState, path);
      if (!item?.file) return null;
      return {
        eTag: item.eTag ?? "",
        cTag: item.cTag ?? "",
        size: item.size ?? 0,
        sha256Hash: item.file.hashes?.sha256Hash,
        quickXorHash: item.file.hashes?.quickXorHash,
        downloadUrl: item["@microsoft.graph.downloadUrl"],
        driveId: item.id,
        parentId: item.parentReference?.id,
        mtime: item.lastModifiedDateTime
          ? new Date(item.lastModifiedDateTime).getTime()
          : 0,
      };
    }),
    getDriveItemMetadataByIds: vi.fn(async (ids: readonly string[]) => {
      const byId = new Map<string, DriveItem | null>();
      for (const id of ids) {
        const item = remoteItemState.find((candidate) => candidate.id === id);
        byId.set(id, item ?? null);
      }
      return byId;
    }),
    getDriveItemMetadata: vi.fn(async (_vaultName: string, path: string) => {
      const item = findRemoteItemByPath(remoteItemState, path);
      if (item && changeNextParentVersion) {
        changeNextParentVersion = false;
        item.eTag = `${item.eTag ?? "etag"}-changed`;
      }
      if (item && moveNextParent) {
        moveNextParent = false;
        item.parentReference = { id: "moved-parent" };
      }
      return item;
    }),
    getDriveItemMetadataById: vi.fn(async (driveItemId: string) => {
      if (driveItemId === scope.filesRootId) {
        return {
            id: scope.filesRootId,
            name: "files",
            folder: {},
            parentReference: { id: scope.vaultFolderId },
            eTag: "etag-root",
        };
      }
      const item = remoteItemState.find((candidate) => candidate.id === driveItemId) ?? null;
      return item;
    }),
    createFolderByParentId: vi.fn(async (parentDriveItemId: string, name: string) => {
      const existing = remoteItemState.find(
        (item) => item.parentReference?.id === parentDriveItemId
          && item.name === name,
      );
      if (existing) return existing;
      const created: DriveItem = {
        id: `created-${remoteItemState.length + 1}`,
        name,
        folder: {},
        parentReference: { id: parentDriveItemId },
        eTag: `etag-created-${remoteItemState.length + 1}`,
        cTag: `ctag-created-${remoteItemState.length + 1}`,
      };
      remoteItemState.push(created);
      if (loseNextFolderCreateResponse) {
        loseNextFolderCreateResponse = false;
        throw new Error("folder create response lost");
      }
      return created;
    }),
    moveItemById: vi.fn(async (
      driveItemId: string,
      eTag: string,
      name: string,
      parentDriveItemId: string,
    ) => {
      const item = remoteItemState.find((candidate) => candidate.id === driveItemId);
      if (!item || item.eTag !== eTag) throw new Error("move precondition failed");
      item.name = name;
      item.parentReference = { id: parentDriveItemId };
      item.eTag = `${eTag}-moved`;
      if (loseNextFolderMoveResponse) {
        loseNextFolderMoveResponse = false;
        throw new Error("folder move response lost");
      }
      return item;
    }),
    listFolderChildrenById: vi.fn(async (driveItemId: string) =>
      remoteItemState.filter((item) => item.parentReference?.id === driveItemId)),
    deleteItem: vi.fn(async (
      _vaultName: string,
      _path: string,
      eTag?: string,
      driveItemId?: string,
    ) => {
      const index = remoteItemState.findIndex((item) => item.id === driveItemId);
      if (index < 0) return;
      if (
        eTag
        && remoteItemState[index].eTag !== eTag
        && remoteItemState[index].cTag !== eTag
      ) {
        throw new Error("delete precondition failed");
      }
      remoteItemState.splice(index, 1);
    }),
    ...(input?.enableCloudBootstrap
      ? {
          readCloudBootstrapV2: cloudBootstrap.read,
          createCloudBootstrapV2: cloudBootstrap.create,
          updateCloudBootstrapV2: cloudBootstrap.update,
          readCloudBootstrapV2ById: cloudBootstrap.readById,
        }
      : {}),
    ...mutations,
  } as unknown as OneDriveClient;

  const state = new StateManager(plugin);
  const diag = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const fileManager = {
    trashFile: vi.fn(async (file: TFile | TFolder) => {
      if (failNextTrash) {
        failNextTrash = false;
        throw new Error("trash failed");
      }
      if (file instanceof TFolder) {
        localFolderPaths.delete(file.path);
        if (loseNextLocalFolderDeleteResponse) {
          loseNextLocalFolderDeleteResponse = false;
          throw new Error("local folder delete response lost");
        }
        return;
      }
      const index = localEntryState.findIndex((entry) => entry.path === file.path);
      if (index >= 0) localEntryState.splice(index, 1);
      if (loseNextLocalFileDeleteResponse) {
        loseNextLocalFileDeleteResponse = false;
        throw new Error("local file delete response lost");
      }
    }),
  };
  const executor = new V2ActivationTestExecutor(
    client,
    scanner,
    state,
    "testVault",
    diag as never,
    fileManager as never,
    localFolderPaths,
  );
  return {
    files,
    hostWrites,
    localEntryState,
    localFolderPaths,
    remoteItemState,
    pluginData,
    rawAdapter,
    plugin,
    scanner,
    client,
    state,
    executor,
    getDelta,
    mutations,
    cloudBootstrap,
    fileManager,
    diag,
    getCloudBootstrap: () => cloudBootstrapObject,
    failManifestRenameOnce: () => { failNextManifestRename = true; },
    commitManifestThenThrowOnce: () => { commitNextManifestThenThrow = true; },
    loseV1BackupWriteResponseOnce: () => {
      loseNextV1BackupWriteResponse = true;
    },
    loseManifestStagedWriteResponseOnce: () => {
      loseNextManifestStagedWriteResponse = true;
    },
    failManifestCommittedReadOnce: () => {
      failNextManifestCommittedRead = true;
    },
    failAncestorManifestRenameOnce: () => {
      failNextAncestorManifestRename = true;
    },
    failStateRenameOnce: () => { failNextStateRename = true; },
    failAuthorityWitnessWriteOnce: () => {
      failNextAuthorityWitnessWrite = true;
    },
    loseAuthorityWitnessWriteResponseOnce: () => {
      loseNextAuthorityWitnessWriteResponse = true;
    },
    loseAuthorityWitnessCommittedWriteResponseOnce: () => {
      loseNextAuthorityWitnessCommittedWriteResponse = true;
    },
    failHoldAuthorityRenameOnce: () => {
      failNextHoldAuthorityRename = true;
    },
    failHoldCompletionWriteOnce: () => {
      failNextHoldCompletionWrite = true;
    },
    failHoldCompletionRenameOnce: () => {
      failNextHoldCompletionRename = true;
    },
    loseHoldAuthorityRenameResponseOnce: () => {
      loseNextHoldAuthorityRenameResponse = true;
    },
    loseHoldCompletionWriteResponseOnce: () => {
      loseNextHoldCompletionWriteResponse = true;
    },
    loseHoldCompletionRenameResponseOnce: () => {
      loseNextHoldCompletionRenameResponse = true;
    },
    loseFolderCreateResponseOnce: () => { loseNextFolderCreateResponse = true; },
    loseFolderMoveResponseOnce: () => { loseNextFolderMoveResponse = true; },
    loseFolderDeleteResponseOnce: () => { loseNextFolderDeleteResponse = true; },
    loseLocalFolderCreateResponseOnce: () => { loseNextLocalFolderCreateResponse = true; },
    loseLocalFolderMoveResponseOnce: () => { loseNextLocalFolderMoveResponse = true; },
    loseLocalFolderDeleteResponseOnce: () => { loseNextLocalFolderDeleteResponse = true; },
    loseLocalFileMoveResponseOnce: () => { loseNextLocalFileMoveResponse = true; },
    loseLocalFileDeleteResponseOnce: () => { loseNextLocalFileDeleteResponse = true; },
    failTrashOnce: () => { failNextTrash = true; },
    conflictFolderDeleteOnce: () => { conflictNextFolderDelete = true; },
    conflictFolderMoveOnce: () => { conflictNextFolderMove = true; },
    changeParentVersionBeforeNextRead: () => { changeNextParentVersion = true; },
    moveParentBeforeNextRead: () => { moveNextParent = true; },
    runOnNextDelta: (callback: () => void) => { onNextDelta = callback; },
    clearSharedProtocolForRecoveredScope: () => {
      sharedProtocolObject = null;
      sharedProtocolV3Object = null;
    },
    clearSharedProtocolV3: () => {
      sharedProtocolV3Object = null;
    },
    seedSharedProtocol: (protocolScope: SyncScope = scope) => {
      sharedProtocolObject = {
        id: protocolBinding.recordId,
        eTag: protocolBinding.recordETag,
        content: JSON.stringify({
          schemaVersion: 1,
          kind: "easy-sync-v2-protocol",
          protocolVersion: 2,
          migrationGeneration: protocolBinding.migrationGeneration,
          scope: protocolScope,
          confirmedAllDevicesUpdatedAt:
            protocolBinding.confirmedAllDevicesUpdatedAt,
          createdAt: protocolBinding.confirmedAllDevicesUpdatedAt,
        }),
      };
    },
    seedSharedProtocolContent: (content: string) => {
      sharedProtocolObject = {
        id: "protocol-recovered-id",
        eTag: "protocol-recovered-etag",
        content,
      };
    },
    seedSharedProtocolV3: (content: string) => {
      sharedProtocolV3Object = {
        id: "protocol-v3-conflict-id",
        eTag: "protocol-v3-conflict-etag",
        content,
      };
    },
    getSharedProtocolV3: () => sharedProtocolV3Object,
    getSharedProtocolV2: () => sharedProtocolObject,
  };
}

export function expectNoFileMutations(
  mutations: ReturnType<typeof makeHarness>["mutations"],
): void {
  expect(mutations.uploadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFileToPath).not.toHaveBeenCalled();
  expect(mutations.deleteItem).not.toHaveBeenCalled();
  expect(mutations.renameItem).not.toHaveBeenCalled();
}

export async function prepareMovedFolderContinuationHarness() {
  const initialContent = "0123456789";
  const initialBytes = new TextEncoder().encode(initialContent);
  const initialHash = await sha256Hex(initialBytes);
  const harness = makeHarness({
    base: [{
      ...baseA,
      hash: initialHash,
      size: initialBytes.byteLength,
    }],
    local: [{
      ...localA,
      hash: initialHash,
      size: initialBytes.byteLength,
    }],
    remoteItems: remoteItems(initialHash),
    initialFiles: { "Notes/a.md": initialContent },
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
  harness.files.set("Archive/a.md", initialContent);
  harness.files.delete("Notes/a.md");
  expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
    .toBe(true);
  const moveRemoteFolder = vi.mocked(
    harness.mutations.moveItemById,
  ).getMockImplementation()!;
  return {
    harness,
    afterMove(mutate: () => void | Promise<void>): void {
      harness.mutations.moveItemById.mockImplementationOnce(async (...args) => {
        const moved = await moveRemoteFolder(...args);
        await mutate();
        return moved;
      });
    },
  };
}

export async function seedExactScopeFreeProtocol(
  harness: ReturnType<typeof makeHarness>,
) {
  const predecessor = await harness.client.readSharedSyncProtocolV2(
    "testVault",
  );
  if (!predecessor) throw new Error("shared V2 predecessor is missing");
  const transport = {
    read: () => harness.client.readSharedSyncProtocolV3("testVault"),
    createOnly: (content: string) =>
      harness.client.createSharedSyncProtocolV3("testVault", content),
    readById: (id: string) => harness.client.readSharedSyncProtocolV3ById(id),
  };
  const seeded = await ensureSharedSyncProtocolV3(
    transport,
    {
      predecessor,
      allowCreate: true,
      observedCurrent: await transport.read(),
      observeAfterCreateFailure: () => transport.read(),
    },
  );
  if (seeded.status !== "ready") {
    throw new Error(`failed to seed exact V3 protocol: ${seeded.reason}`);
  }
  vi.mocked(harness.client.readSharedSyncProtocolV2).mockClear();
  vi.mocked(harness.client.readSharedSyncProtocolV3).mockClear();
  vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();
  vi.mocked(harness.client.readSharedSyncProtocolV3ById).mockClear();
  return seeded.binding;
}

export async function activateV2WithFolderScopeDisabled(
  harness: ReturnType<typeof makeHarness>,
  isDisabledPath: (path: string) => boolean,
): Promise<() => void> {
  let enabled = false;
  vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
    (path) => enabled || !isDisabledPath(path),
  );
  vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
    (path) => enabled || !isDisabledPath(path),
  );
  await harness.state.load();
  const activated = await harness.executor.run(
    "manual",
    {},
    false,
    undefined,
    { activateV2State: true },
  );
  expect(activated.success).toBe(true);
  return () => {
    enabled = true;
  };
}

export async function prepareReviewedFolderSubtreeHarness(
  options: { folderContentTags?: boolean } = {},
) {
  const content = "reviewed cloud subtree";
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256Hex(bytes);
  const paths = ["Issues", "Issues/CAD"];
  const initialFolderPaths = [
    ".obsidian",
    ".obsidian/plugins",
    ".obsidian/plugins/easy-sync",
    ...paths,
  ];
  const folders = remoteFolderTree(initialFolderPaths);
  // OneDrive Personal never returns folder cTags; files keep theirs.
  if (options.folderContentTags !== false) {
    for (const folder of folders) {
      folder.cTag = `ctag-${folder.id}`;
    }
  }
  const filePath = "Issues/CAD/drawing.md";
  const harness = makeHarness({
    base: [{ path: filePath, size: bytes.byteLength, hash, eTag: "etag-drawing" }],
    local: [{
      path: filePath,
      size: bytes.byteLength,
      mtime: 1,
      hash,
      binary: false,
    }],
    localFolders: initialFolderPaths.map((path) => ({ path })),
    remoteItems: [
      ...folders,
      {
        id: "drawing",
        name: "drawing.md",
        file: { hashes: { sha256Hash: hash } },
        size: bytes.byteLength,
        parentReference: {
          id: findRemoteItemByPath(folders, "Issues/CAD")!.id,
        },
        eTag: "etag-drawing",
        cTag: "ctag-drawing",
      },
    ],
    initialFiles: { [filePath]: content },
    remoteFileContents: { [filePath]: content },
  });
  await harness.state.load();
  expect((await harness.executor.run(
    "manual",
    {},
    false,
    undefined,
    { activateV2State: true },
  )).success).toBe(true);
  harness.localEntryState.splice(0);
  harness.files.delete(filePath);
  harness.localFolderPaths.delete("Issues/CAD");
  harness.localFolderPaths.delete("Issues");
  harness.localFolderPaths.add("Archive");
  expect(await harness.executor.run("manual")).toMatchObject({
    deferred: 2,
    errors: 0,
  });
  const reviewed = await harness.executor
    .getFolderSubtreeReviewSnapshot("Issues");
  expect(reviewed).not.toBeNull();
  return { harness, reviewed: reviewed!, filePath, content, hash };
}

export async function prepareAmbiguousEmptyFolderHarness(
  options: { contentTag?: string | null } = {},
) {
  const contentTag = options.contentTag === null
    ? undefined
    : options.contentTag ?? "ctag-folder-notes";
  const harness = makeHarness({
    base: [],
    local: [],
    localFolders: [{ path: "Notes" }],
    remoteItems: [{
      id: "folder-notes",
      name: "Notes",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-folder-notes",
      ...(contentTag ? { cTag: contentTag } : {}),
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
  harness.localFolderPaths.delete("Notes");
  harness.localFolderPaths.add("Archive");
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
      path: "Notes",
      issueCode: "anchored-folder-missing-local",
    }),
  ]);
  const reviewed = await harness.executor.getEmptyFolderResolutionSnapshot("Notes");
  expect(reviewed).toMatchObject({
    path: "Notes",
    remoteId: "folder-notes",
    remoteETag: "etag-folder-notes",
    ...(contentTag ? { remoteCTag: contentTag } : {}),
    candidatePaths: ["Archive"],
  });
  return { harness, reviewed: reviewed! };
}

/** Unwrap one manual-resolution entry that is expected to be ready to open. */
export function readySnapshot<T>(entry: ManualResolutionEntrySnapshot<T>): T {
  expect(entry.reason).toBe("ready");
  if (!entry.snapshot) throw new Error("expected a ready resolution snapshot");
  return entry.snapshot;
}

export async function prepareUnanchoredSharedFolderHarness() {
  const folderPaths = [".obsidian", ".obsidian/plugins"];
  const harness = makeHarness();
  await harness.state.load();
  expect((await harness.executor.run(
    "manual",
    {},
    false,
    undefined,
    { activateV2State: true },
  )).success).toBe(true);
  for (const path of folderPaths) harness.localFolderPaths.add(path);
  harness.remoteItemState.push(...remoteFolderTree(folderPaths));

  const deferred = await harness.executor.run(
    "manual",
  );
  expect(deferred).toMatchObject({
    success: true,
    foldersCreated: 0,
    foldersMoved: 0,
    foldersDeleted: 0,
    deferred: 2,
    errors: 0,
  });
  expect(harness.state.pendingIssues).toEqual([
    expect.objectContaining({
      path: ".obsidian",
      issueCode: "unanchored-shared-folder",
    }),
    expect.objectContaining({
      path: ".obsidian/plugins",
      issueCode: "unanchored-shared-folder",
    }),
  ]);
  const reviewed = readySnapshot(
    await harness.executor.getSharedFolderIdentityResolutionSnapshot(
      ".obsidian/plugins",
    ),
  );
  expect(reviewed).toMatchObject({
    path: ".obsidian/plugins",
    folders: [
      { path: ".obsidian" },
      { path: ".obsidian/plugins" },
    ],
  });
  return { harness, reviewed: reviewed! };
}

export async function stageConfirmedDescendantWithoutFolderAnchors(
  options: {
    seedFileAnchor?: boolean;
    remoteContent?: string;
    omitRemoteHash?: boolean;
  } = {},
): Promise<{
  harness: ReturnType<typeof makeHarness>;
  pluginFolders: string[];
  pluginFile: LocalFileEntry;
  remotePluginFile: DriveItem;
}> {
  const pluginFolders = [
    ".obsidian",
    ".obsidian/plugins",
    ".obsidian/plugins/easy-sync",
  ];
  const encodedRemoteContent = options.remoteContent === undefined
    ? null
    : new TextEncoder().encode(options.remoteContent);
  const pluginFile: LocalFileEntry = {
    path: ".obsidian/plugins/easy-sync/manifest.json",
    size: encodedRemoteContent?.byteLength ?? 20,
    mtime: 2,
    hash: encodedRemoteContent
      ? await sha256Hex(encodedRemoteContent.buffer)
      : hashB,
    binary: false,
  };
  const remotePluginFolders = remoteFolderTree(pluginFolders);
  const remotePluginFile: DriveItem = {
    id: "file-easy-sync-manifest",
    name: "manifest.json",
    size: pluginFile.size,
    file: {
      hashes: options.omitRemoteHash
        ? {}
        : { sha256Hash: pluginFile.hash },
    },
    parentReference: { id: remotePluginFolders.at(-1)!.id },
    lastModifiedDateTime: "2026-07-30T00:00:00.000Z",
    eTag: "etag-easy-sync-manifest",
    cTag: "ctag-easy-sync-manifest",
  };
  const harness = makeHarness({
    ...(options.remoteContent === undefined
      ? {}
      : {
          remoteFileContents: {
            [pluginFile.path]: options.remoteContent,
          },
        }),
  });
  await harness.state.load();
  expect((await harness.executor.run(
    "manual",
    {},
    false,
    undefined,
    { activateV2State: true },
  )).success).toBe(true);

  harness.localEntryState.push({ ...pluginFile });
  for (const path of pluginFolders) harness.localFolderPaths.add(path);
  harness.remoteItemState.push(...remotePluginFolders, remotePluginFile);
  await harness.state.setRemoteState(
    [
      ...harness.state.remoteSnapshot,
      {
        path: pluginFile.path,
        size: pluginFile.size,
        mtime: Date.parse(remotePluginFile.lastModifiedDateTime!),
        eTag: remotePluginFile.eTag!,
        cTag: remotePluginFile.cTag!,
        sha256Hash: pluginFile.hash,
        driveId: remotePluginFile.id,
        parentId: remotePluginFile.parentReference!.id!,
      },
    ],
    "https://graph.example/delta-current",
    scope,
    [
      ...harness.state.remoteFolders,
      ...pluginFolders.map((path, index) => ({
        path,
        driveId: remotePluginFolders[index]!.id,
        parentId: remotePluginFolders[index]!.parentReference!.id!,
        name: remotePluginFolders[index]!.name,
        eTag: remotePluginFolders[index]!.eTag,
      })),
    ],
  );
  if (options.seedFileAnchor !== false) {
    await harness.state.upsertBaseEntries([{
      path: pluginFile.path,
      hash: pluginFile.hash,
      size: pluginFile.size,
      eTag: remotePluginFile.eTag!,
    }]);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
      lastPath: pluginFile.path,
      contentHash: pluginFile.hash,
    }));
  } else {
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
      lastPath: pluginFile.path,
    }));
  }
  expect(
    Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath),
  ).toEqual(["Notes"]);
  for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
  return {
    harness,
    pluginFolders,
    pluginFile,
    remotePluginFile,
  };
}

export async function addHashlessReconstructionFiles(
  harness: ReturnType<typeof makeHarness>,
  parentId: string,
  count: number,
  differentCount = 0,
  minimumContentBytes = 0,
): Promise<{
  allPaths: string[];
  equalPaths: string[];
  differentPaths: string[];
  remoteContents: Map<string, string>;
}> {
  const remoteContents = new Map<string, string>();
  const equalPaths: string[] = [];
  const differentPaths: string[] = [];
  for (let index = 0; index < count; index++) {
    const path =
      `.obsidian/plugins/easy-sync/reconstruction-${index.toString().padStart(2, "0")}.json`;
    const isDifferent = index >= count - differentCount;
    const localPrefix = isDifferent
      ? `local-${index.toString().padStart(2, "0")}`
      : `equal-${index.toString().padStart(2, "0")}`;
    const remotePrefix = isDifferent
      ? `cloud-${index.toString().padStart(2, "0")}`
      : localPrefix;
    const localContent = localPrefix.padEnd(minimumContentBytes, "l");
    const remoteContent = remotePrefix.padEnd(
      minimumContentBytes,
      isDifferent ? "r" : "l",
    );
    const localBytes = new TextEncoder().encode(localContent);
    const local: LocalFileEntry = {
      path,
      size: localBytes.byteLength,
      mtime: index + 10,
      hash: await sha256Hex(localBytes.buffer),
      binary: false,
    };
    harness.localEntryState.push(local);
    harness.files.set(path, localContent);
    harness.remoteItemState.push({
      id: `reconstruction-file-${index}`,
      name: path.slice(path.lastIndexOf("/") + 1),
      size: new TextEncoder().encode(remoteContent).byteLength,
      file: { hashes: {} },
      parentReference: { id: parentId },
      lastModifiedDateTime: "2026-07-30T00:00:00.000Z",
      eTag: `etag-reconstruction-${index}`,
      cTag: `ctag-reconstruction-${index}`,
    });
    remoteContents.set(path, remoteContent);
    (isDifferent ? differentPaths : equalPaths).push(path);
  }
  vi.mocked(harness.mutations.downloadFile).mockImplementation(
    async (_vaultName: string, path: string) =>
      new TextEncoder().encode(remoteContents.get(path) ?? "").buffer,
  );
  return {
    allPaths: [...equalPaths, ...differentPaths],
    equalPaths,
    differentPaths,
    remoteContents,
  };
}

export function createRestartedExecutor(
  harness: ReturnType<typeof makeHarness>,
  state: StateManager,
): V2ActivationTestExecutor {
  return new V2ActivationTestExecutor(
    harness.client,
    harness.scanner,
    state,
    "testVault",
    harness.diag as never,
    harness.fileManager as never,
    harness.localFolderPaths,
  );
}

export async function stageOrdinaryV2Review(
  harness: ReturnType<typeof makeHarness>,
): Promise<{
  authorization: PlanReviewAuthorization;
  plan: SyncPlan;
}> {
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

  let plan: SyncPlan | null = null;
  const publishReview = vi.fn(async (candidate: SyncPlan) => {
    plan = candidate;
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
  expect(publishReview).toHaveBeenCalledOnce();
  expect(plan).toMatchObject({
    canonicalIdentity: expect.any(Object),
    items: [],
  });
  const authorization = harness.state.planReviewAuthorization;
  expect(authorization).toMatchObject({
    revision: expect.any(Number),
    scope,
    canonicalIdentity: (plan as SyncPlan).canonicalIdentity,
  });
  expect(authorization?.reviewKind).toBeUndefined();

  return {
    authorization: structuredClone(authorization!),
    plan: plan!,
  };
}

export function public113NormalizedFixture(): {
  pluginData: Record<string, unknown>;
  sidecars: Record<string, unknown>;
} {
  const raw = readFileSync(
    "tests/fixtures/release-1.1.3-upgrade.json",
    "utf8",
  );
  return JSON.parse(
    raw
      .replaceAll("fixture-account-113", scope.accountId)
      .replaceAll("fixture-drive-113", scope.driveId)
      .replaceAll("fixture-vault-folder-113", scope.vaultFolderId)
      .replaceAll("fixture-files-root-113", scope.filesRootId),
  ) as {
    pluginData: Record<string, unknown>;
    sidecars: Record<string, unknown>;
  };
}

export function public113CleanFixtureInput(): NonNullable<
  Parameters<typeof makeHarness>[0]
> {
  const normalized = public113NormalizedFixture();
  const pluginData = structuredClone(normalized.pluginData);
  const baseSnapshot = pluginData[
    "easy-sync-base-snapshot"
  ] as Record<string, BaseFileEntry>;
  const stableBase = structuredClone(baseSnapshot["notes/stable.md"]);
  pluginData["easy-sync-base-snapshot"] = {
    [stableBase.path]: stableBase,
  };
  pluginData["easy-sync-mutation-ledger"] = [];
  pluginData["easy-sync-pending-conflicts"] = [];
  pluginData["easy-sync-pending-issues"] = [];
  pluginData["easy-sync-pending-remote-deletes"] = [];

  const remoteState = structuredClone(
    normalized.sidecars[legacyPaths.remoteStateFile],
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
    folders: Record<string, {
      path: string;
      driveId: string;
      parentId: string;
      name: string;
    }>;
  };
  const stableRemote = structuredClone(
    remoteState.entries["notes/stable.md"],
  );
  remoteState.entries = {
    [stableRemote.path]: stableRemote,
  };
  const notesFolder = structuredClone(
    remoteState.folders["fixture-folder-notes"],
  );
  remoteState.folders = {
    [notesFolder.driveId]: notesFolder,
  };

  const baseContent = structuredClone(
    normalized.sidecars[legacyPaths.baseContentFile],
  ) as Record<string, string>;
  const scanCache = structuredClone(
    normalized.sidecars[legacyPaths.scanCacheFile],
  ) as {
    format: number;
    entries: Record<string, {
      mtime: number;
      size: number;
      hash: string;
      binary: boolean;
    }>;
  };
  const stableScan = structuredClone(
    scanCache.entries["notes/stable.md"],
  );
  scanCache.entries = {
    "notes/stable.md": stableScan,
  };

  return {
    base: [stableBase],
    local: [{
      path: stableBase.path,
      size: stableBase.size,
      mtime: stableScan.mtime,
      hash: stableBase.hash,
      binary: false,
    }],
    localFolders: [{ path: "notes" }],
    remoteItems: [
      {
        id: notesFolder.driveId,
        name: notesFolder.name,
        folder: { childCount: 1 },
        parentReference: { id: notesFolder.parentId },
        eTag: "etag-folder-notes-113",
      },
      {
        id: stableRemote.driveId,
        name: "stable.md",
        size: stableRemote.size,
        file: {
          hashes: {
            ...(stableRemote.sha256Hash
              ? { sha256Hash: stableRemote.sha256Hash }
              : {}),
          },
        },
        parentReference: { id: stableRemote.parentId },
        lastModifiedDateTime:
          new Date(stableRemote.mtime).toISOString(),
        eTag: stableRemote.eTag,
        cTag: stableRemote.cTag,
      },
    ],
    initialFiles: {
      [paths.remoteStateFile]: JSON.stringify(remoteState),
      [paths.baseContentFile]: JSON.stringify({
        [stableBase.path]: baseContent[stableBase.path],
      }),
      [paths.scanCacheFile]: JSON.stringify(scanCache),
    },
    pluginData,
  };
}

export async function public113ReinstalledMixedVersionFixtureInput(input: {
  baseCount?: number;
  equalCount?: number;
  remoteOnlyCount?: number;
  folderCount?: number;
} = {}) {
  const baseContent = "public-1.1.3 anchored bytes\n";
  const equalContent = "mixed-version identical bytes\n";
  const localDifferentContent = "iphone-local\n";
  const remoteDifferentContent = "windows-remote-version-is-longer\n";
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(baseContent);
  const equalBytes = encoder.encode(equalContent);
  const localDifferentBytes = encoder.encode(localDifferentContent);
  const remoteDifferentBytes = encoder.encode(remoteDifferentContent);
  const [baseHash, equalHash, localDifferentHash, remoteDifferentHash] =
    await Promise.all([
      sha256Hex(baseBytes),
      sha256Hex(equalBytes),
      sha256Hex(localDifferentBytes),
      sha256Hex(remoteDifferentBytes),
    ]);
  const basePaths = Array.from(
    { length: input.baseCount ?? 351 },
    (_, index) => `public113-base-${String(index).padStart(3, "0")}.md`,
  );
  const equalPaths = Array.from(
    { length: input.equalCount ?? 494 },
    (_, index) => `public113-equal-${String(index).padStart(3, "0")}.md`,
  );
  const differentPath = "public113-size-different.md";
  const remoteOnlyPaths = Array.from(
    { length: input.remoteOnlyCount ?? 17 },
    (_, index) => `public113-remote-only-${String(index).padStart(2, "0")}.md`,
  );
  const folderPaths = Array.from(
    { length: input.folderCount ?? 137 },
    (_, index) => `public113-folder-${String(index).padStart(3, "0")}`,
  );
  const base: BaseFileEntry[] = [];
  const local: LocalFileEntry[] = [];
  const remoteItems: DriveItem[] = [];
  const initialFiles: Record<string, string> = {};
  const remoteFileContents: Record<string, string> = {};
  const pendingConflicts: SyncPlan["items"] = [];
  const remoteTimestamp = Date.parse("2026-08-01T00:00:00.000Z");

  for (const [index, path] of basePaths.entries()) {
    const eTag = `etag-base-${index}`;
    const cTag = `ctag-base-${index}`;
    const driveId = `drive-base-${index}`;
    base.push({
      path,
      hash: baseHash,
      size: baseBytes.byteLength,
      eTag,
    });
    local.push({
      path,
      size: baseBytes.byteLength,
      mtime: remoteTimestamp + index,
      hash: baseHash,
      binary: false,
    });
    remoteItems.push({
      id: driveId,
      name: path,
      size: baseBytes.byteLength,
      file: {},
      parentReference: { id: scope.filesRootId },
      lastModifiedDateTime: new Date(remoteTimestamp + index).toISOString(),
      eTag,
      cTag,
    });
    initialFiles[path] = baseContent;
    remoteFileContents[path] = baseContent;
  }

  const addUnanchoredSharedFile = (input: {
    path: string;
    index: number;
    localContent: string;
    localBytes: Uint8Array;
    localHash: string;
    remoteContent: string;
    remoteBytes: Uint8Array;
  }): void => {
    const driveId = `drive-shared-${input.index}`;
    const eTag = `etag-shared-${input.index}`;
    const cTag = `ctag-shared-${input.index}`;
    const mtime = remoteTimestamp + basePaths.length + input.index;
    const localEntry: LocalFileEntry = {
      path: input.path,
      size: input.localBytes.byteLength,
      mtime,
      hash: input.localHash,
      binary: false,
    };
    const remoteEntry = {
      path: input.path,
      driveId,
      parentId: scope.filesRootId,
      size: input.remoteBytes.byteLength,
      mtime,
      eTag,
      cTag,
    };
    local.push(localEntry);
    remoteItems.push({
      id: driveId,
      name: input.path,
      size: input.remoteBytes.byteLength,
      file: {},
      parentReference: { id: scope.filesRootId },
      lastModifiedDateTime: new Date(mtime).toISOString(),
      eTag,
      cTag,
    });
    initialFiles[input.path] = input.localContent;
    remoteFileContents[input.path] = input.remoteContent;
    pendingConflicts.push({
      type: SyncActionType.Conflict,
      path: input.path,
      local: { ...localEntry },
      remote: remoteEntry,
      reason: "reason.newFileBothSides",
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: scope.accountId,
        scope: { ...scope },
        local: {
          exists: true,
          hash: localEntry.hash,
          size: localEntry.size,
        },
        remote: {
          exists: true,
          driveId,
          eTag,
        },
        ancestorHash: null,
      },
    });
  };

  for (const [index, path] of equalPaths.entries()) {
    addUnanchoredSharedFile({
      path,
      index,
      localContent: equalContent,
      localBytes: equalBytes,
      localHash: equalHash,
      remoteContent: equalContent,
      remoteBytes: equalBytes,
    });
  }
  addUnanchoredSharedFile({
    path: differentPath,
    index: equalPaths.length,
    localContent: localDifferentContent,
    localBytes: localDifferentBytes,
    localHash: localDifferentHash,
    remoteContent: remoteDifferentContent,
    remoteBytes: remoteDifferentBytes,
  });

  for (const [index, path] of remoteOnlyPaths.entries()) {
    const content = `windows-v2-remote-only-${index}\n`;
    const bytes = encoder.encode(content);
    remoteItems.push({
      id: `drive-remote-only-${index}`,
      name: path,
      size: bytes.byteLength,
      file: {},
      parentReference: { id: scope.filesRootId },
      lastModifiedDateTime: new Date(
        remoteTimestamp + basePaths.length + equalPaths.length + index + 1,
      ).toISOString(),
      eTag: `etag-remote-only-${index}`,
      cTag: `ctag-remote-only-${index}`,
    });
    remoteFileContents[path] = content;
  }

  for (const [index, path] of folderPaths.entries()) {
    remoteItems.push({
      id: `drive-folder-${index}`,
      name: path,
      folder: { childCount: 0 },
      parentReference: { id: scope.filesRootId },
      eTag: `etag-folder-${index}`,
    });
  }
  const remoteStateEntries = Object.fromEntries(
    remoteItems
      .filter((item) => Boolean(item.file))
      .map((item) => [item.name, {
        path: item.name,
        driveId: item.id,
        parentId: item.parentReference?.id ?? scope.filesRootId,
        size: item.size ?? 0,
        mtime: item.lastModifiedDateTime
          ? Date.parse(item.lastModifiedDateTime)
          : 0,
        eTag: item.eTag ?? "",
        cTag: item.cTag ?? "",
      }]),
  );
  const remoteStateFolders = Object.fromEntries(
    remoteItems
      .filter((item) => Boolean(item.folder))
      .map((item) => [item.id, {
        path: item.name,
        driveId: item.id,
        parentId: item.parentReference?.id ?? scope.filesRootId,
        name: item.name,
      }]),
  );
  initialFiles[paths.remoteStateFile] = JSON.stringify({
    version: 1,
    generation: 0,
    scope,
    deltaLink: "https://graph.example/public-1.1.3-reinstall-delta",
    entries: remoteStateEntries,
    folders: remoteStateFolders,
  });

  return {
    fixtureInput: {
      base,
      local,
      localFolders: folderPaths.map((path) => ({ path })),
      remoteItems,
      initialFiles,
      remoteFileContents,
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
        "easy-sync-mutation-ledger": [],
        "easy-sync-pending-conflicts": pendingConflicts,
        "easy-sync-pending-issues": [],
        "easy-sync-pending-remote-deletes": [],
        "easy-sync-plan-review-active": true,
        "easy-sync-plan-review-counts": {
          uploads: 0,
          downloads: 0,
          deletes: 0,
          conflicts: pendingConflicts.length,
          skipped: 0,
        },
        "easy-sync-plan-review-items": pendingConflicts.map((item) => ({
          type: item.type,
          path: item.path,
          reason: item.reason,
          localHash: item.local?.hash,
          remoteETag: item.remote?.eTag,
        })),
        "easy-sync-plan-review-digest":
          "public-1.1.3-reinstall-review-digest",
        "easy-sync-plan-review-revision": 4,
        "easy-sync-plan-review-scope": { ...scope },
      },
      enableCloudBootstrap: true,
    } satisfies NonNullable<Parameters<typeof makeHarness>[0]>,
    basePaths,
    equalPaths,
    differentPath,
    remoteOnlyPaths,
    folderPaths,
    remoteDifferentHash,
    remoteDifferentSize: remoteDifferentBytes.byteLength,
    remoteDifferentETag: `etag-shared-${equalPaths.length}`,
    remoteDifferentCTag: `ctag-shared-${equalPaths.length}`,
    remoteDifferentDriveId: `drive-shared-${equalPaths.length}`,
  };
}

export async function public113InterruptedAnchoredDownloadFixtureInput(): Promise<{
  fixtureInput: NonNullable<Parameters<typeof makeHarness>[0]>;
  ledger: MutationLedgerEntryV1[];
  base: BaseFileEntry;
  currentHash: string;
  currentETag: string;
}> {
  const fixtureInput = public113CleanFixtureInput();
  const base = structuredClone(fixtureInput.base![0]!);
  const currentContent =
    "public 1.1.3 downloaded these bytes before its receipt write stopped\n";
  const currentBytes = new TextEncoder().encode(currentContent);
  const currentHash = await sha256Hex(currentBytes);
  const currentETag = "etag-public-1.1.3-download-current";
  const remoteFile = fixtureInput.remoteItems!.find((item) => item.file)!;
  remoteFile.size = currentBytes.byteLength;
  remoteFile.eTag = currentETag;
  remoteFile.cTag = "ctag-public-1.1.3-download-current";
  remoteFile.file = {};

  fixtureInput.local = [{
    path: base.path,
    size: currentBytes.byteLength,
    mtime: 2,
    hash: currentHash,
    binary: false,
  }];
  fixtureInput.initialFiles![base.path] = currentContent;
  fixtureInput.remoteFileContents = {
    [base.path]: currentContent,
  };

  const remoteState = JSON.parse(
    fixtureInput.initialFiles![paths.remoteStateFile],
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
    folders: Record<string, unknown>;
  };
  const advancedRemote = remoteState.entries[base.path]!;
  advancedRemote.size = currentBytes.byteLength;
  advancedRemote.mtime++;
  advancedRemote.eTag = currentETag;
  advancedRemote.cTag = "ctag-public-1.1.3-download-current";
  delete advancedRemote.sha256Hash;
  fixtureInput.initialFiles![paths.remoteStateFile] =
    JSON.stringify(remoteState);

  const ledger: MutationLedgerEntryV1[] = [{
    intent: {
      version: 1,
      operationId: "public-1.1.3-interrupted-anchored-download",
      planRevision: 12,
      scope: { ...scope },
      action: "download",
      path: base.path,
      expectedLocal: {
        exists: true,
        hash: base.hash,
        size: base.size,
      },
      expectedRemote: {
        exists: true,
        driveId: advancedRemote.driveId,
        eTag: currentETag,
        size: currentBytes.byteLength,
      },
      createdAt: 1_721_234_507_000,
    },
    receipt: null,
  }];
  fixtureInput.pluginData!["easy-sync-mutation-ledger"] = ledger;
  return {
    fixtureInput,
    ledger,
    base,
    currentHash,
    currentETag,
  };
}

export function public113StalePendingFixtureInput(): NonNullable<
  Parameters<typeof makeHarness>[0]
> {
  const input = public113CleanFixtureInput();
  const source = public113NormalizedFixture().pluginData;
  const pluginData = structuredClone(input.pluginData!);
  for (const key of [
    "easy-sync-pending-conflicts",
    "easy-sync-pending-remote-deletes",
    "easy-sync-pending-issues",
    "easy-sync-plan-review-active",
    "easy-sync-plan-review-counts",
    "easy-sync-plan-review-items",
    "easy-sync-plan-review-digest",
    "easy-sync-plan-review-revision",
    "easy-sync-plan-review-scope",
  ]) {
    pluginData[key] = structuredClone(source[key]);
  }
  pluginData["easy-sync-mutation-ledger"] = [];
  return { ...input, pluginData };
}

export function public113ReceiptedEmptyAccountFixtureInput(): {
  fixtureInput: NonNullable<Parameters<typeof makeHarness>[0]>;
  releaseCompatibleLedger: Array<Record<string, unknown>>;
} {
  const fixtureInput = public113CleanFixtureInput();
  const stableBase = Object.values(
    fixtureInput.pluginData!["easy-sync-base-snapshot"] as Record<
      string,
      BaseFileEntry
    >,
  )[0]!;
  const remoteState = JSON.parse(
    fixtureInput.initialFiles![paths.remoteStateFile],
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
  const stableRemote = remoteState.entries[stableBase.path]!;
  const operationId = "release-1.1.3-receipted-empty-account";
  const releaseCompatibleLedger = [{
    intent: {
      version: 1,
      operationId,
      planRevision: 12,
      scope: {
        ...scope,
        accountId: "",
      },
      action: "download",
      path: stableBase.path,
      expectedLocal: {
        exists: true,
        hash: stableBase.hash,
        size: stableBase.size,
      },
      expectedRemote: {
        exists: true,
        driveId: stableRemote.driveId,
        eTag: stableRemote.eTag,
        size: stableRemote.size,
        ...(stableRemote.sha256Hash
          ? { sha256Hash: stableRemote.sha256Hash }
          : {}),
      },
      createdAt: 1_721_234_505_000,
      releaseFutureIntentField: { mustSurvive: true },
    },
    receipt: {
      version: 1,
      operationId,
      completedAt: 1_721_234_506_000,
      checkpoint: {
        baseUpserts: [stableBase],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
        releaseFutureCheckpointField: { mustSurvive: true },
      },
      releaseFutureReceiptField: { mustSurvive: true },
    },
    releaseFutureEntryField: { mustSurvive: true },
  }];
  fixtureInput.pluginData!["easy-sync-mutation-ledger"] =
    releaseCompatibleLedger;
  return { fixtureInput, releaseCompatibleLedger };
}


export async function snapshotIndexedDbActiveStore(
  databaseId: string,
): Promise<{
  meta: unknown;
  remoteNodes: unknown[];
  anchors: unknown[];
  folderAnchors: unknown[];
}> {
  const db = await openDB(stateV2ActiveIndexedDbDatabaseName(databaseId), 1);
  const tx = db.transaction(
    ["meta", "remoteNodes", "anchors", "folderAnchors"],
    "readonly",
  );
  const meta = await tx.objectStore("meta").get("state");
  const remoteNodes = await tx.objectStore("remoteNodes").getAll();
  const anchors = await tx.objectStore("anchors").getAll();
  const folderAnchors = await tx.objectStore("folderAnchors").getAll();
  await tx.done;
  db.close();
  return { meta, remoteNodes, anchors, folderAnchors };
}

export async function restoreIndexedDbActiveStore(
  databaseId: string,
  snapshot: {
    meta: unknown;
    remoteNodes: unknown[];
    anchors: unknown[];
    folderAnchors: unknown[];
  },
): Promise<void> {
  const db = await openDB(stateV2ActiveIndexedDbDatabaseName(databaseId), 1);
  const tx = db.transaction(
    ["meta", "remoteNodes", "anchors", "folderAnchors"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("meta").clear(),
    tx.objectStore("remoteNodes").clear(),
    tx.objectStore("anchors").clear(),
    tx.objectStore("folderAnchors").clear(),
    tx.objectStore("meta").put(snapshot.meta, "state"),
    ...snapshot.remoteNodes.map((value) =>
      tx.objectStore("remoteNodes").put(value as { id: string }, (value as { id: string }).id),
    ),
    ...snapshot.anchors.map((value) =>
      tx.objectStore("anchors").put(value as { anchorId: string }, (value as { anchorId: string }).anchorId),
    ),
    ...snapshot.folderAnchors.map((value) =>
      tx.objectStore("folderAnchors").put(
        value as { anchorId: string },
        (value as { anchorId: string }).anchorId,
      ),
    ),
    tx.done,
  ]);
  db.close();
}

export function makeJournalHarness(): {
  harness: ReturnType<typeof makeHarness>;
  activeStores: Map<string, StateV2IndexedDbActiveStore[]>;
  recoveries: Map<string, StateV2IndexedDbRecoveryStore>;
} {
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
  return { harness, activeStores, recoveries };
}

export async function commitOneFileRevision(
  harness: ReturnType<typeof makeHarness>,
  marker: string,
  mtime: number,
  executor: SyncExecutor = harness.executor,
): Promise<void> {
  const bytes = new TextEncoder().encode(marker);
  const hash = await sha256Hex(bytes);
  harness.files.set(localA.path, marker);
  harness.localEntryState[0] = {
    ...harness.localEntryState[0],
    hash,
    size: bytes.byteLength,
    mtime,
  };
  harness.mutations.uploadFile.mockImplementationOnce(async () => {
    const remote = harness.remoteItemState.find(
      (item) => item.id === "file-a",
    )!;
    remote.size = bytes.byteLength;
    remote.file = { hashes: { sha256Hash: hash } };
    remote.eTag = `etag-${marker}`;
    remote.cTag = `ctag-${marker}`;
    return { ...remote, parentReference: { ...remote.parentReference } };
  });
  const result = await executor.run("manual");
  expect(result.success).toBe(true);
}
