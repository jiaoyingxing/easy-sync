import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Platform, TFile, TFolder, type DataAdapter } from "obsidian";
import EasySyncPlugin from "../src/main";
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
import { StateV2IndexedDbActiveStore } from "../src/sync/state-v2-indexeddb-active";
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

const paths = getEasySyncPaths(".obsidian");
const legacyPaths = getEasySyncLegacyPaths(".obsidian");
const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const protocolBinding = {
  schemaVersion: 1 as const,
  protocolVersion: 2 as const,
  migrationGeneration: "a".repeat(64),
  confirmedAllDevicesUpdatedAt: 1,
  recordId: "protocol-id",
  recordETag: "protocol-etag",
};
const hashB = "b".repeat(64);
const localA: LocalFileEntry = {
  path: "Notes/a.md",
  size: 10,
  mtime: 1,
  hash: hashA,
  binary: false,
};
const baseA: BaseFileEntry = {
  path: localA.path,
  hash: localA.hash,
  size: localA.size,
  eTag: "etag-a",
};
const communityPluginPath = ".obsidian/community-plugins.json";
let harnessVaultInstanceSequence = 0;

interface ActivationTestRunOptions extends SyncRunOptions {
  /**
   * Test-only convenience: exercise the real two-round production migration
   * transaction and return the confirmation result for an exact zero plan.
   * It never enters the production SyncExecutor API or bundle.
   */
  activateV2State?: true;
}

class V2ActivationTestExecutor extends SyncExecutor {
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

function remoteItems(hash = hashA): DriveItem[] {
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

function remoteItemsWithCommunityPluginState(
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

async function sharedCalendarPluginBundleFixture() {
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

function remoteFolderTree(
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

function findRemoteItemByPath(
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

function applyRemoteUpload(
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

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function makeHarness(input?: {
  base?: BaseFileEntry[];
  local?: LocalFileEntry[];
  localFolders?: Array<{ path: string }>;
  remoteHash?: string;
  remoteItems?: DriveItem[];
  initialFiles?: Record<string, string>;
  remoteFileContents?: Record<string, string>;
  pluginData?: Record<string, unknown>;
  folderScanComplete?: boolean;
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
        localEntryState.some((entry) => entry.path === path)
          ? new TFile(path)
          : null),
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
      folderScanFailures: [],
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
  };
}

function expectNoFileMutations(
  mutations: ReturnType<typeof makeHarness>["mutations"],
): void {
  expect(mutations.uploadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFileToPath).not.toHaveBeenCalled();
  expect(mutations.deleteItem).not.toHaveBeenCalled();
  expect(mutations.renameItem).not.toHaveBeenCalled();
}

async function prepareMovedFolderContinuationHarness() {
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

async function seedExactScopeFreeProtocol(
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

async function activateV2WithFolderScopeDisabled(
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

async function prepareReviewedFolderSubtreeHarness() {
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
  for (const folder of folders) {
    folder.cTag = `ctag-${folder.id}`;
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

async function prepareAmbiguousEmptyFolderHarness(
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

async function prepareUnanchoredSharedFolderHarness() {
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
  const reviewed =
    await harness.executor.getSharedFolderIdentityResolutionSnapshot(
      ".obsidian/plugins",
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

async function stageConfirmedDescendantWithoutFolderAnchors(
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

async function addHashlessReconstructionFiles(
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

function createRestartedExecutor(
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

async function stageOrdinaryV2Review(
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

function public113NormalizedFixture(): {
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

function public113CleanFixtureInput(): NonNullable<
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

async function public113ReinstalledMixedVersionFixtureInput(input: {
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

async function public113InterruptedAnchoredDownloadFixtureInput(): Promise<{
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

function public113StalePendingFixtureInput(): NonNullable<
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

function public113ReceiptedEmptyAccountFixtureInput(): {
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
      message: "result.sharedControlReadUnavailable",
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
      message: "result.sharedControlReadUnavailable",
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
      message: "result.sharedControlReadUnavailable",
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

  it("deletes an inactive IndexedDB candidate when a confirmed public-1.1.3 migration is cancelled", async () => {
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
      expect((await indexedDB.databases()).some(
        (entry) => entry.name === databaseName,
      )).toBe(true);

      await expect(
        harness.state.clearPlanReview(
          harness.state.planReviewAuthorization!,
        ),
      ).resolves.toBe(true);
      expect((await indexedDB.databases()).some(
        (entry) => entry.name === databaseName,
      )).toBe(false);
      expect(harness.state.activeV2MigrationHold).toBeNull();
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(true);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
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
    expect(harness.rawAdapter.writeBinary).toHaveBeenCalledOnce();
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
    expect(harness.rawAdapter.writeBinary).toHaveBeenCalledOnce();
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
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(restartedState.isV2StateActive).toBe(false);
    expect(restartedState.legacyAutoSyncAllowed).toBe(true);
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
    const { fixtureInput, ledger } =
      await public113InterruptedAnchoredDownloadFixtureInput();
    const remoteFile = fixtureInput.remoteItems!.find((item) => item.file)!;
    remoteFile.eTag = "etag-after-public-download-intent";
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: false,
      deferred: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
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
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
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
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
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
      .resolves.toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    expect(harness.files.get(paths.remoteStateFile))
      .toBe(originalRemoteState);
    expect(harness.files.get(paths.baseContentFile))
      .toBe(originalBaseContent);
    expect(harness.files.get(paths.scanCacheFile))
      .toBe(originalScanCache);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
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
      canonicalIdentity: authorization.canonicalIdentity,
    });
    expect(restartedState.planReviewAuthorization?.revision)
      .toBeGreaterThan(authorization.revision);
    expect(restartedState.isV2StateActive).toBe(false);
    expect(restartedState.legacyAutoSyncAllowed).toBe(true);
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
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
    const reviewed = await harness.executor.getStaleIdentityResolutionSnapshot(
      "Notes/a.md",
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
    const reviewed = await harness.executor.getStaleIdentityResolutionSnapshot(
      "Notes/a.md",
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
    const reviewed = await harness.executor.getStaleIdentityResolutionSnapshot(
      "Notes",
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

  it("does not offer direct cloud deletion without a descendant-sensitive tag", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness({
      contentTag: null,
    });
    expect(reviewed.remoteCTag).toBeUndefined();

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")?.folder)
      .toBeTruthy();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toHaveLength(1);
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

  it("recovers a lost remote file-delete response only after exact item 404", async () => {
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
    harness.loseFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).toBeNull();
    expect((await harness.executor.run("manual")).deleted).toBe(0);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
  });

  it("keeps V2 blocked when a deleted file path is 404 but its exact item moved", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.name = "moved.md";
    harness.localEntryState.splice(0);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "delete-path-404-item-moved",
      planRevision: 1,
      scope,
      action: "deleteRemote",
      path: localA.path,
      expectedLocal: { exists: false },
      expectedRemote: {
        exists: true,
        driveId: remote.id,
        eTag: remote.eTag!,
        size: remote.size!,
        sha256Hash: remote.file?.hashes?.sha256Hash,
      },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<void>;
    }).recoverMutationLedger(scope)).rejects.toThrow(
      "Mutation outcome requires manual review",
    );

    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([{
      intent,
      receipt: null,
    }]);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("recovers a lost local file-delete response without trashing the file twice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "file-a"),
      1,
    );
    harness.loseLocalFileDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(harness.localEntryState).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).deleted).toBe(0);
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "unreceipted", receipted: false },
    { label: "receipted", receipted: true },
  ])("keeps a $label deleteLocal unresolved when its old remote ID moved", async ({ receipted }) => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    harness.remoteItemState.push({
      id: "folder-archive-delete-local",
      name: "Archive",
      folder: { childCount: 1 },
      parentReference: { id: scope.filesRootId },
      eTag: "etag-archive-delete-local",
    });
    remote.parentReference = { id: "folder-archive-delete-local" };
    remote.name = "moved.md";
    harness.localEntryState.splice(0);
    harness.files.delete(localA.path);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: `delete-local-id-moved-${receipted}`,
      planRevision: 1,
      scope,
      action: "deleteLocal",
      path: localA.path,
      expectedLocal: {
        exists: true,
        hash: localA.hash,
        size: localA.size,
      },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);
    const receipt: MutationReceiptV1 | null = receipted
      ? {
          version: 1,
          operationId: intent.operationId,
          completedAt: 11,
          checkpoint: {
            baseUpserts: [],
            baseRemovals: [intent.path],
            remoteUpserts: [],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [intent.path],
          },
        }
      : null;
    if (receipt) await harness.state.recordMutationReceipt(receipt);

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<void>;
    }).recoverMutationLedger(scope)).rejects.toThrow(/manual review|no longer matches/i);

    expect(harness.state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("deletes a local folder only after its remote-deleted children and a second local empty check", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);

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
    expect(harness.localEntryState).toHaveLength(0);
    expect(harness.localFolderPaths.has("Notes")).toBe(false);
    expect(harness.rawAdapter.list).toHaveBeenCalledWith("Notes");
    expect(harness.fileManager.trashFile).toHaveBeenCalled();
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("retires an anchored folder without confirmation when both the local and remote tree are already absent", async () => {
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
    harness.localFolderPaths.clear();
    harness.remoteItemState.splice(0);

    const retired = await harness.executor.run("manual");

    expect(retired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersDeleted: 1,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toHaveLength(0);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersDeleted: 0,
      errors: 0,
    });
  });

  it("keeps an empty remote-deleted folder pending until the existing delete approval is used", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.remoteItemState.splice(0);

    const pending = await harness.executor.run("manual");

    expect(pending).toMatchObject({
      success: true,
      foldersDeleted: 0,
      errors: 0,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(harness.state.pendingRemoteDeletes).toEqual([
      expect.objectContaining({
        type: "deleteLocalFolder",
        path: "Empty",
        requiresConfirmation: true,
      }),
    ]);

    await harness.executor.confirmRemoteDelete("Empty", false);

    expect(harness.localFolderPaths.has("Empty")).toBe(false);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("confirms nested folder deletes child-first even when the UI passes the parent first", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Parent" }, { path: "Parent/Child" }],
      remoteItems: [
        {
          id: "folder-parent",
          name: "Parent",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-parent",
        },
        {
          id: "folder-child",
          name: "Child",
          folder: {},
          parentReference: { id: "folder-parent" },
          eTag: "etag-folder-child",
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
    harness.remoteItemState.splice(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.state.pendingRemoteDeletes.map((item) => item.path).sort())
      .toEqual(["Parent", "Parent/Child"]);

    await harness.executor.confirmRemoteDeletes(["Parent", "Parent/Child"]);

    expect(harness.fileManager.trashFile.mock.calls.map(([file]) => file.path))
      .toEqual(["Parent/Child", "Parent"]);
    expect(harness.localFolderPaths.has("Parent/Child")).toBe(false);
    expect(harness.localFolderPaths.has("Parent")).toBe(false);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("recreates a pending remote-deleted empty folder when the user keeps local", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.remoteItemState.splice(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);

    await harness.executor.rejectRemoteDelete("Empty");

    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder).toBeTruthy();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .not.toBe("folder-empty");
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersCreated: 0,
      foldersDeleted: 0,
      errors: 0,
    });
  });

  it("recovers a lost empty-folder delete response without issuing a second delete", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
        cTag: "ctag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");
    harness.loseFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
  });

  it("keeps an automatic remote empty-folder delete fail-closed without a folder cTag", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder)
      .toBeTruthy();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("retries a failed folder-delete checkpoint without deleting twice", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
        cTag: "ctag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");
    harness.failStateRenameOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("recovers a lost local empty-folder delete response without trashing twice", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);
    harness.loseLocalFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("Empty")).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it("blocks a remote folder delete when the final all-pages child check is non-empty", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");
    (harness.client.listFolderChildrenById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{
        id: "late-child",
        name: "late.md",
        file: {},
        parentReference: { id: "folder-empty" },
      }]);

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("defers a remote folder delete when an ancestor changes its projected path", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Parent" }, { path: "Parent/Empty" }],
      remoteItems: [
        {
          id: "folder-parent",
          name: "Parent",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-parent",
        },
        {
          id: "folder-empty",
          name: "Empty",
          folder: {},
          parentReference: { id: "folder-parent" },
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
    harness.localFolderPaths.delete("Parent/Empty");
    (harness.client.getDriveItemMetadataById as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (driveItemId: string) => {
        const item = harness.remoteItemState.find(
          (candidate) => candidate.id === driveItemId,
        ) ?? null;
        const parent = harness.remoteItemState.find(
          (candidate) => candidate.id === "folder-parent",
        );
        if (parent) parent.name = "ParentChanged";
        return item;
      });

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.remoteItemState.some((item) => item.id === "folder-empty"))
      .toBe(true);
  });

  it("turns a 412 folder delete into a deferred item without retiring the anchor", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");
    harness.conflictFolderDeleteOnce();

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(
      Object.values(harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId),
    ).toContainEqual(expect.objectContaining({ remoteId: "folder-empty" }));
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("stops before the destructive folder delete when cancellation arrives during recheck", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.localFolderPaths.delete("Empty");
    (harness.client.listFolderChildrenById as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        harness.executor.cancel();
        return [];
      });

    const cancelled = await harness.executor.run("manual");

    expect(cancelled).toMatchObject({
      success: false,
      foldersDeleted: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("keeps a local folder and a recoverable intent outcome when trash fails", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
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
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);
    harness.failTrashOnce();

    const failed = await harness.executor.run("manual");

    expect(failed).toMatchObject({
      success: false,
      foldersDeleted: 0,
      errors: 1,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(harness.state.mutationLedger).toHaveLength(0);

    const retried = await harness.executor.run("manual");
    expect(retried).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(false);
  });

  it("never deletes a synced config-directory folder shell automatically", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: ".obsidian" }, { path: ".obsidian/snippets" }],
      remoteItems: [
        {
          id: "folder-config",
          name: ".obsidian",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-config",
        },
        {
          id: "folder-snippets",
          name: "snippets",
          folder: {},
          parentReference: { id: "folder-config" },
          eTag: "etag-folder-snippets",
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
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "folder-snippets"),
      1,
    );

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.localFolderPaths.has(".obsidian/snippets")).toBe(true);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("accepts only the newly expanded EasySync folder identities without mutations", async () => {
    const easySyncFolders: DriveItem[] = [
      {
        id: "folder-obsidian",
        name: ".obsidian",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-obsidian",
      },
      {
        id: "folder-plugins",
        name: "plugins",
        folder: {},
        parentReference: { id: "folder-obsidian" },
        eTag: "etag-folder-plugins",
      },
      {
        id: "folder-easy-sync",
        name: "easy-sync",
        folder: {},
        parentReference: { id: "folder-plugins" },
        eTag: "etag-folder-easy-sync",
      },
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...easySyncFolders],
    });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
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

    configFoldersIncluded = true;
    for (const path of [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ]) {
      harness.localFolderPaths.add(path);
    }
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      (data) => {
        data["sync-plugin-files"] = true;
      },
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: [
          ".obsidian",
          ".obsidian/plugins",
          ".obsidian/plugins/easy-sync",
        ],
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 1,
      folders: [
        { path: ".obsidian", driveId: "folder-obsidian" },
        { path: ".obsidian/plugins", driveId: "folder-plugins" },
        {
          path: ".obsidian/plugins/easy-sync",
          driveId: "folder-easy-sync",
        },
      ],
    });
    expect(harness.state.planReviewActive).toBe(false);
    expect(await harness.state.hasV2RecoveryJournal()).toBe(false);
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "ready",
      revision: 1,
    });
    harness.getDelta.mockClear();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await harness.executor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
      "Notes",
    ]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.getDelta).toHaveBeenCalledTimes(1);
    expectNoFileMutations(harness.mutations);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("keeps stable folder identities quiet after an explicit scope contraction", async () => {
    const contractedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
      ".obsidian/themes",
      ".obsidian/themes/Notation",
      ".obsidian/themes/Primary",
      ".obsidian/themes/Things 3",
    ];
    const harness = makeHarness({
      localFolders: [
        { path: "Notes" },
        ...contractedPaths.map((path) => ({ path })),
      ],
      remoteItems: [
        ...remoteItems(),
        ...remoteFolderTree(contractedPaths),
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
    const committedBefore = harness.state.getCommittedV2Envelope()!;
    const anchorsBefore = structuredClone(
      committedBefore.folderAnchors!.byAnchorId,
    );
    const remoteFoldersBefore = Object.fromEntries(
      Object.entries(committedBefore.remoteIndex.itemsById)
        .filter(([, node]) => node.kind === "folder"),
    );

    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => !path.startsWith(".obsidian"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian"),
    );
    vi.mocked(harness.scanner.scanAll).mockResolvedValue({
      entries: harness.localEntryState.map((entry) => ({ ...entry })),
      folders: [{ path: "Notes" }],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "config-scope:on",
        targetSettingsFingerprint: "config-scope:off",
        expandedFolderPaths: [],
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );
    for (const path of contractedPaths) {
      await harness.state.reconcilePendingIssues([{
        path,
        actionType: SyncActionType.FolderDeferred,
        reason: "scope-crossing",
        updatedAt: 1,
        consecutiveFailures: 3,
      }], []);
    }
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const first = await harness.executor.run("manual");
    const second = await harness.executor.run("manual");

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
    }
    expect(harness.state.pendingIssues).toEqual([]);
    expect(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).toEqual(anchorsBefore);
    expect(Object.fromEntries(
      Object.entries(
        harness.state.getCommittedV2Envelope()!.remoteIndex.itemsById,
      ).filter(([, node]) => node.kind === "folder"),
    )).toEqual(remoteFoldersBefore);
    expect(contractedPaths.every((path) =>
      harness.localFolderPaths.has(path)
    )).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("accepts a newly expanded all-community-plugin folder tree in one state-only commit", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/calendar",
      ".obsidian/plugins/dataview",
      ".obsidian/plugins/quickadd",
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
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:all",
        expandedFolderPaths: expandedPaths,
      },
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await harness.executor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("joins a remote-only community plugin through the original settings journey without a second manual sync", async () => {
    const pluginId = "obsidian-pkmer";
    const manifestId = "pkmer";
    const pluginRoot = `.obsidian/plugins/${pluginId}`;
    const mainPath = `${pluginRoot}/main.js`;
    const manifestPath = `${pluginRoot}/manifest.json`;
    const stylesPath = `${pluginRoot}/styles.css`;
    const manifestContent = JSON.stringify({
      id: manifestId,
      name: "PKMer",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    });
    const remoteContents = {
      [mainPath]: "pkmer-main",
      [manifestPath]: manifestContent,
      [stylesPath]: "pkmer-styles",
    };
    const pluginFolders = remoteFolderTree([
      ".obsidian",
      ".obsidian/plugins",
      pluginRoot,
    ]);
    const pluginFolderId = pluginFolders.at(-1)!.id;
    const remotePluginFiles: DriveItem[] = await Promise.all(
      Object.entries(remoteContents).map(async ([path, content], index) => {
        const contentBytes = new TextEncoder().encode(content);
        return {
          id: `calendar-file-${index + 1}`,
          name: path.slice(path.lastIndexOf("/") + 1),
          size: contentBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(contentBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-02T00:00:00.000Z",
          eTag: `etag-calendar-${index + 1}`,
          cTag: `ctag-calendar-${index + 1}`,
        };
      }),
    );
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }],
      remoteItems: [
        ...remoteItems(),
        ...pluginFolders,
        ...remotePluginFiles,
      ],
      remoteFileContents: remoteContents,
    });
    let pluginScopeEnabled = false;
    let selectedPluginEnabled = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || (selectedPluginEnabled
          && (path === pluginRoot || path.startsWith(`${pluginRoot}/`))),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || (pluginScopeEnabled
          && (path === ".obsidian" || path === ".obsidian/plugins"))
        || (selectedPluginEnabled && path === pluginRoot),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.add(".obsidian");
    harness.localFolderPaths.add(".obsidian/plugins");
    await harness.state.setRemoteCommunityPluginCatalog(
      await buildRemoteCommunityPluginCatalog({
        scope: harness.state.remoteScope!,
        configDir: ".obsidian",
        items: [...pluginFolders, ...remotePluginFiles],
        manifestObservations: [],
        observedAt: 1,
        ownPluginId: "easy-sync",
      }),
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    harness.getDelta.mockClear();

    const initialInventory = await buildCommunityPluginInventory(
      harness.rawAdapter as unknown as DataAdapter,
      ".obsidian",
      "easy-sync",
      [pluginId],
      harness.state.remoteSnapshot,
      [pluginId],
      [],
      [],
      null,
      [pluginId],
    );
    const remoteOnlyVisibleBeforeJoin =
      initialInventory.find((item) => item.id === pluginId)?.remote === true;

    Object.assign(harness.scanner as object, {
      setConfig: vi.fn((config: {
        includePluginCode?: boolean;
        pluginCodeSelection?: Parameters<typeof isPluginSelected>[0];
      }) => {
        pluginScopeEnabled = config.includePluginCode === true;
        selectedPluginEnabled = Boolean(
          config.pluginCodeSelection
          && isPluginSelected(config.pluginCodeSelection, pluginId),
        );
      }),
    });
    const settingsPlugin = new EasySyncPlugin();
    Object.assign(settingsPlugin as object, {
      app: {
        ...harness.plugin.app,
        workspace: {
          getLeavesOfType: vi.fn().mockReturnValue([]),
        },
      },
      manifest: harness.plugin.manifest,
      scanner: harness.scanner,
      state: harness.state,
      syncExecutor: harness.executor,
      onedrive: harness.plugin.onedrive,
      syncPluginFiles: false,
      syncEditorSettings: false,
      syncAppearance: false,
      syncThemes: false,
      syncHotkeys: false,
      syncCorePlugins: false,
      syncBookmarks: false,
      syncCommunityPlugins: false,
      syncPluginData: false,
      communityPluginSyncPolicy: {
        version: 1,
        files: {
          mode: "none",
          pluginIds: [],
        },
        data: { mode: "none", pluginIds: [] },
      },
      excludedFolders: [],
    });
    vi.spyOn(settingsPlugin as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(settingsPlugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    const scheduleCommunityPluginJoinSync = vi.spyOn(
      settingsPlugin as never,
      "scheduleCommunityPluginJoinSync",
    );
    const settingsUpdateQueue = new SequentialSettingsUpdateQueue();
    let settingsUpdateError: unknown;
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: settingsPlugin,
      inventory: initialInventory,
      busyPluginRows: new Set<string>(),
      pendingPluginValues: new Map<string, boolean>(),
      settingsUpdateQueue,
      destroyed: true,
      renderPluginListArea: vi.fn(),
      showSyncPathSettingsError: (error: unknown) => {
        settingsUpdateError = error;
      },
    });

    await settingsPlugin.updateCommunityPluginFilesScope(true);
    expect(harness.state.activeSyncScopeExpansion?.folders.map(
      (folder) => folder.path,
    )).toEqual([".obsidian", ".obsidian/plugins"]);

    (modal as unknown as {
      queuePluginSelectionUpdate(
        column: "files" | "data",
        targetPluginId: string,
        enabled: boolean,
      ): void;
    }).queuePluginSelectionUpdate("files", pluginId, true);
    await settingsUpdateQueue.whenIdle();
    expect(harness.state.activeSyncScopeExpansion?.folders.map(
      (folder) => folder.path,
    )).toEqual([".obsidian", ".obsidian/plugins"]);

    expect(settingsUpdateError).toBeUndefined();
    expect(settingsPlugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: [],
    });
    expect(
      settingsPlugin.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase,
    ).toBe("join-requested");
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect([mainPath, manifestPath, stylesPath].some(
      (path) => harness.files.has(path),
    )).toBe(false);
    expectNoFileMutations(harness.mutations);
    const immediateSyncScheduled =
      scheduleCommunityPluginJoinSync.mock.calls.length > 0;
    const automaticResult = await (settingsPlugin as unknown as {
      dispatchSyncRun(request: { mode: "auto" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "auto" });
    expect(automaticResult).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 3,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining([
      ".obsidian",
      ".obsidian/plugins",
    ]));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toContain(pluginRoot);
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    const restoredBeforeManualRun = [mainPath, manifestPath, stylesPath]
      .every((path) => harness.files.has(path));

    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const reopenedSettings = new EasySyncPlugin();
    vi.spyOn(reopenedSettings, "loadData").mockResolvedValue(
      structuredClone(harness.pluginData),
    );
    await reopenedSettings.loadSyncSettings();
    const restartedExecutor = createRestartedExecutor(harness, restartedState);
    Object.assign(reopenedSettings as object, {
      app: settingsPlugin.app,
      manifest: settingsPlugin.manifest,
      scanner: harness.scanner,
      state: restartedState,
      syncExecutor: restartedExecutor,
      onedrive: harness.plugin.onedrive,
    });
    await reopenedSettings.ensureCommunityPluginParticipationInitialized();
    expect(
      restartedState.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase,
    ).toBe("participating");
    const enabledMissingHasActionablePhase =
      restartedState.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase === "participating";
    expect(enabledMissingHasActionablePhase).toBe(true);

    expect([mainPath, manifestPath, stylesPath].every(
      (path) => harness.files.has(path),
    )).toBe(true);
    expect(harness.getDelta).toHaveBeenCalled();
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toContain(pluginRoot);

    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    settingsPlugin.stopAutoSync();
    await restartedState.close();

    expect({
      remoteOnlyVisibleBeforeJoin,
      immediateSyncScheduled,
      restoredBeforeManualRun,
      enabledMissingHasActionablePhase,
    }).toEqual({
      remoteOnlyVisibleBeforeJoin: true,
      immediateSyncScheduled: true,
      restoredBeforeManualRun: true,
      enabledMissingHasActionablePhase: true,
    });
  });

  it.each([
    {
      label: "a required local parent is missing",
      localFolderPaths: [".obsidian"],
      remoteId: "current",
    },
    {
      label: "the bound remote root changed",
      localFolderPaths: [".obsidian", ".obsidian/plugins"],
      remoteId: "replacement-root",
      expandedFolderPaths: [".obsidian/plugins/remote-plugin"],
    },
    {
      label: "the plugin root was not authorized by this scope change",
      localFolderPaths: [".obsidian", ".obsidian/plugins"],
      remoteId: "current",
      expandedFolderPaths: [".obsidian"],
    },
  ])("keeps join ancestor identity fail-closed when $label", async ({
    localFolderPaths,
    remoteId,
    expandedFolderPaths = [".obsidian/plugins/remote-plugin"],
  }) => {
    const pluginRoot = ".obsidian/plugins/remote-plugin";
    const folders = remoteFolderTree([
      ".obsidian",
      ".obsidian/plugins",
      pluginRoot,
    ]);
    const remoteRoot = folders.at(-1)!;
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...folders],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of localFolderPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      ["remote-plugin"],
      {
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:remote-plugin",
        expandedFolderPaths,
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );

    const accepted = await harness.state.acceptSyncScopeExpansionFolders({
      expectedRevision: 1,
      scope,
      localFiles: [],
      localFolders: localFolderPaths.map((path) => ({ path })),
      localFolderScanComplete: true,
      remoteIdentityComplete: true,
      sourceBoundCommunityPluginJoinRoots: [{
        path: pluginRoot,
        remoteId: remoteId === "current" ? remoteRoot.id : remoteId,
      }],
    });

    expect(accepted).toEqual({ status: "stale", accepted: 0 });
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a desktop-only empty plugin root non-participating when mobile scope is enabled from off", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const pluginId = "realtime-transcription";
      const rootPath = `.obsidian/plugins/${pluginId}`;
      const manifestPath = `${rootPath}/manifest.json`;
      const mainPath = `${rootPath}/main.js`;
      const manifestContent = JSON.stringify({
        id: pluginId,
        version: "1.5.4",
        minAppVersion: "1.4.0",
        isDesktopOnly: true,
      });
      const mainContent = "desktop-only-main";
      const manifestBytes = new TextEncoder().encode(manifestContent);
      const mainBytes = new TextEncoder().encode(mainContent);
      const pluginFolders = remoteFolderTree([
        ".obsidian",
        ".obsidian/plugins",
        rootPath,
      ]);
      const pluginFolderId = pluginFolders.at(-1)!.id;
      const remotePluginFiles: DriveItem[] = [
        {
          id: "realtime-transcription-manifest",
          name: "manifest.json",
          size: manifestBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(manifestBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-01T00:00:00.000Z",
          eTag: "etag-realtime-transcription-manifest",
          cTag: "ctag-realtime-transcription-manifest",
        },
        {
          id: "realtime-transcription-main",
          name: "main.js",
          size: mainBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(mainBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-01T00:00:00.000Z",
          eTag: "etag-realtime-transcription-main",
          cTag: "ctag-realtime-transcription-main",
        },
      ];
      const harness = makeHarness({
        localFolders: [
          { path: "Notes" },
          { path: ".obsidian" },
          { path: ".obsidian/plugins" },
          { path: rootPath },
        ],
        remoteItems: [
          ...remoteItems(),
          ...pluginFolders,
          ...remotePluginFiles,
        ],
        remoteFileContents: {
          [manifestPath]: manifestContent,
          [mainPath]: mainContent,
        },
      });
      harness.executor.setCommunityPluginSyncPolicy({
        version: 1,
        files: { mode: "none", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      });
      const enableScope = await activateV2WithFolderScopeDisabled(
        harness,
        (path) => path.startsWith(".obsidian"),
      );

      enableScope();
      harness.executor.setCommunityPluginSyncPolicy({
        version: 1,
        files: {
          mode: "selected",
          pluginIds: [pluginId],
        },
        data: { mode: "none", pluginIds: [] },
      });
      await harness.state.commitSyncPathSettingsChange(
        (path) => harness.scanner.shouldSyncPath(path),
        () => undefined,
        [pluginId],
        {
          previousSettingsFingerprint: "community-plugins:off",
          targetSettingsFingerprint: `community-plugins:selected:${pluginId}`,
          expandedFolderPaths: [
            ".obsidian",
            ".obsidian/plugins",
            rootPath,
          ],
          requiresCompleteRemoteIdentitySnapshot: true,
        },
      );
      harness.getDelta.mockClear();
      for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
      harness.rawAdapter.mkdir.mockClear();
      harness.rawAdapter.writeBinary.mockClear();

      const first = await harness.executor.run("manual");

      expect(first).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
      expect(harness.mutations.downloadFile.mock.calls.map(
        (call) => call[1],
      )).toEqual([manifestPath]);
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.rawAdapter.mkdir).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(harness.state.pendingIssues).toEqual([]);
      expect(harness.state.getCommunityPluginManifestObservations())
        .toEqual([expect.objectContaining({ pluginId })]);
      expect(harness.state.remoteSnapshot.map((entry) => entry.path))
        .toEqual(expect.arrayContaining([manifestPath, mainPath]));

      const restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      const restartedExecutor = createRestartedExecutor(
        harness,
        restartedState,
      );
      restartedExecutor.setCommunityPluginSyncPolicy({
        version: 1,
        files: {
          mode: "selected",
          pluginIds: [pluginId],
        },
        data: { mode: "none", pluginIds: [] },
      });
      harness.getDelta.mockClear();
      harness.mutations.downloadFile.mockClear();
      harness.mutations.downloadFileToPath.mockClear();
      harness.rawAdapter.mkdir.mockClear();
      harness.rawAdapter.writeBinary.mockClear();

      const stable = await restartedExecutor.run("manual");

      expect(stable).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
      expect(harness.getDelta).toHaveBeenCalledTimes(1);
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.rawAdapter.mkdir).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(restartedState.pendingIssues).toEqual([]);
      await restartedState.close();
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("rebuilds a trimmed remote file index when file scope re-expands under existing folder anchors", async () => {
    const pluginFolders = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/calendar",
    ];
    const manifestText = JSON.stringify({
      id: "calendar",
      version: "2.0.0",
    });
    const mainText = "calendar-main";
    const manifestBytes = new TextEncoder().encode(manifestText);
    const mainBytes = new TextEncoder().encode(mainText);
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localPluginFiles: LocalFileEntry[] = [
      {
        path: manifestPath,
        size: manifestBytes.byteLength,
        mtime: 2,
        hash: await sha256Hex(manifestBytes.buffer),
        binary: false,
      },
      {
        path: mainPath,
        size: mainBytes.byteLength,
        mtime: 2,
        hash: await sha256Hex(mainBytes.buffer),
        binary: false,
      },
    ];
    const remotePluginFolders = remoteFolderTree(pluginFolders);
    const remotePluginFiles: DriveItem[] = localPluginFiles.map(
      (entry, index) => ({
        id: `calendar-file-${index + 1}`,
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        size: entry.size,
        file: { hashes: { sha256Hash: entry.hash } },
        parentReference: { id: remotePluginFolders.at(-1)!.id },
        lastModifiedDateTime: "2026-07-30T00:00:00.000Z",
        eTag: `calendar-etag-${index + 1}`,
        cTag: `calendar-ctag-${index + 1}`,
      }),
    );
    const harness = makeHarness({
      local: [localA, ...localPluginFiles],
      localFolders: [
        { path: "Notes" },
        ...pluginFolders.map((path) => ({ path })),
      ],
      remoteItems: [
        ...remoteItems(),
        ...remotePluginFolders,
        ...remotePluginFiles,
      ],
      initialFiles: {
        [manifestPath]: manifestText,
        [mainPath]: mainText,
      },
    });
    let pluginFilesIncluded = true;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) =>
        pluginFilesIncluded
        || !path.startsWith(".obsidian/plugins/calendar/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockReturnValue(true);
    harness.getDelta.mockImplementation(async (
      _vaultName: string,
      deltaLink?: string,
    ) => ({
      value: deltaLink ? [] : [...harness.remoteItemState],
      "@odata.deltaLink": "https://graph.example/delta-current",
    }));
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path))
      .toEqual(expect.arrayContaining([manifestPath, mainPath]));

    pluginFilesIncluded = false;
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "community-plugins:on",
        targetSettingsFingerprint: "community-plugins:off",
        expandedFolderPaths: [],
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );
    expect((await harness.executor.run("manual")).success).toBe(true);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path))
      .not.toEqual(expect.arrayContaining([manifestPath, mainPath]));

    pluginFilesIncluded = true;
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:on",
        expandedFolderPaths: pluginFolders,
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    harness.getDelta.mockClear();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    await restartedState.setPlanReviewBundle(
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
    const blocked = await restartedExecutor.run("manual");
    expect(blocked).toMatchObject({
      success: false,
      deferred: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(restartedState.activeSyncScopeExpansion).not.toBeNull();
    expectNoFileMutations(harness.mutations);
    await restartedState.clearPlanReview();

    const expanded = await restartedExecutor.run("manual");

    expect(expanded).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(harness.getDelta).toHaveBeenCalledWith("testVault");
    expect(harness.getDelta).not.toHaveBeenCalledWith(
      "testVault",
      expect.any(String),
    );
    expect(restartedState.remoteSnapshot.map((entry) => entry.path))
      .toEqual(expect.arrayContaining([manifestPath, mainPath]));
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expectNoFileMutations(harness.mutations);

    harness.getDelta.mockClear();
    expect((await restartedExecutor.run("manual")).success).toBe(true);
    expect(harness.getDelta).toHaveBeenCalledWith(
      "testVault",
      "https://graph.example/delta-current",
    );
    expectNoFileMutations(harness.mutations);
  });

  it("accepts folder identities first discovered by the required scope-expansion refresh", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: remoteItems(),
    });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    expect(harness.state.remoteFolders.map((folder) => folder.path))
      .not.toEqual(expect.arrayContaining(expandedPaths));

    configFoldersIncluded = true;
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    harness.remoteItemState.push(...remoteFolderTree(expandedPaths));
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1(
            { includePaths: [], includeOwnPluginCode: false },
          ),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeSyncScopeExpansion?.folderScopeTransition)
      .toBeDefined();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await restartedExecutor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining(expandedPaths));
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("does not use one folder-range expansion to accept an unknown folder already in scope", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const unrelatedPath = "Shared";
    const harness = makeHarness({ remoteItems: remoteItems() });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    configFoldersIncluded = true;
    for (const path of [...expandedPaths, unrelatedPath]) {
      harness.localFolderPaths.add(path);
    }
    harness.remoteItemState.push(...remoteFolderTree([
      ...expandedPaths,
      unrelatedPath,
    ]));
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      deferred: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    const anchors = Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath);
    expect(anchors).toEqual(expect.arrayContaining(expandedPaths));
    expect(anchors).not.toContain(unrelatedPath);
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({ path: unrelatedPath }),
    ]);
    expectNoFileMutations(harness.mutations);
  });

  it("recovers a scope-expansion marker after restart before any envelope commit", async () => {
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

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expectNoFileMutations(harness.mutations);
  });

  it("UJ-003 merges consecutive settings changes into one sync and stays stable after a cold reopen", async () => {
    const allExpandedPaths = [
      ".obsidian",
      ".obsidian/themes",
      ".obsidian/snippets",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const ownPluginPath = ".obsidian/plugins/easy-sync/main.js";
    const remoteFolders = remoteFolderTree(allExpandedPaths);
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolders],
    });
    let activeConfig: Parameters<LocalScanner["setConfig"]>[0] = {
      includePaths: [],
      includeOwnPluginCode: false,
      includePluginCode: false,
      includePluginData: false,
    };
    let activeFolderScope = createFolderSyncScopeSnapshotV1(
      activeConfig,
      ".obsidian",
      "easy-sync",
    );
    const setConfig = vi.fn(
      (config: Parameters<LocalScanner["setConfig"]>[0]) => {
        activeConfig = {
          ...activeConfig,
          ...config,
          includePaths: [...(config.includePaths ?? activeConfig.includePaths ?? [])],
        };
        activeFolderScope = createFolderSyncScopeSnapshotV1(
          activeConfig,
          ".obsidian",
          "easy-sync",
        );
      },
    );
    Object.assign(harness.scanner as object, { setConfig });
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || isFolderPathInSyncScopeSnapshot(activeFolderScope, path),
    );
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation((path) => {
      if (!path.startsWith(".obsidian/")) return true;
      if (
        path === ".obsidian/plugins/easy-sync"
        || path.startsWith(".obsidian/plugins/easy-sync/")
      ) return activeConfig.includeOwnPluginCode === true;
      return (activeConfig.includePaths ?? []).some((includedPath) => {
        const normalized = includedPath.replace(/\/+$/, "");
        return includedPath.endsWith("/")
          ? path === normalized || path.startsWith(`${normalized}/`)
          : path === normalized;
      });
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    for (const path of allExpandedPaths) harness.localFolderPaths.add(path);
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    harness.getDelta.mockClear();

    const settingsPlugin = new EasySyncPlugin();
    Object.assign(settingsPlugin as object, {
      app: {
        ...harness.plugin.app,
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
      manifest: harness.plugin.manifest,
      scanner: harness.scanner,
      state: harness.state,
      syncExecutor: harness.executor,
      onedrive: harness.plugin.onedrive,
      syncPluginFiles: false,
      syncEditorSettings: false,
      syncAppearance: false,
      syncThemes: false,
      syncHotkeys: false,
      syncCorePlugins: false,
      syncBookmarks: false,
      syncCommunityPlugins: false,
      syncPluginData: false,
      communityPluginSyncPolicy: {
        version: 1,
        files: { mode: "selected", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      excludedFolders: [],
    });
    vi.spyOn(settingsPlugin as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(settingsPlugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    settingsPlugin.applySyncPathSettings();

    await settingsPlugin.updateSyncPathSettings({ syncEditorSettings: true });
    await settingsPlugin.updateSyncPathSettings({ syncAppearance: true });
    await settingsPlugin.updateSyncPathSettings({ syncThemes: true });
    await settingsPlugin.updateSyncPathSettings({ syncHotkeys: true });
    await settingsPlugin.updateSyncPathSettings({ syncCorePlugins: true });
    await settingsPlugin.updateCommunityPluginFilesScope(true);
    expect(harness.scanner.shouldSyncPath(ownPluginPath)).toBe(false);
    await settingsPlugin.updateSyncPathSettings({ syncPluginFiles: true });

    const pendingScope = harness.state.activeSyncScopeExpansion!;
    expect(pendingScope.revision).toBeGreaterThanOrEqual(7);
    expect(pendingScope.requiresCompleteRemoteIdentitySnapshot).toBe(true);
    expect(pendingScope.folderScopeTransition!.previous).toMatchObject({
      includePaths: [],
      includeOwnPluginCode: false,
      includePluginCode: false,
    });
    for (const path of allExpandedPaths) {
      expect(isFolderPathInSyncScopeSnapshot(
        pendingScope.folderScopeTransition!.target,
        path,
      )).toBe(true);
    }
    expect(pendingScope.folders.map((folder) => folder.path)).toEqual(
      expect.arrayContaining(allExpandedPaths),
    );
    expect(harness.scanner.shouldSyncPath(ownPluginPath)).toBe(true);
    expect(activeConfig.includePluginCode).toBe(true);
    expect(activeConfig.includeOwnPluginCode).toBe(true);
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const first = await (settingsPlugin as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(first).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining(allExpandedPaths));
    expectNoFileMutations(harness.mutations);

    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(harness, restartedState);
    const reopenedSettings = new EasySyncPlugin();
    Object.assign(reopenedSettings as object, {
      app: settingsPlugin.app,
      manifest: settingsPlugin.manifest,
      scanner: harness.scanner,
      state: restartedState,
      syncExecutor: restartedExecutor,
      onedrive: harness.plugin.onedrive,
    });
    vi.spyOn(reopenedSettings, "loadData").mockResolvedValue(
      structuredClone(harness.pluginData),
    );
    vi.spyOn(reopenedSettings as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(reopenedSettings as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    await reopenedSettings.loadSyncSettings();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const stable = await (reopenedSettings as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(stable).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(reopenedSettings).toMatchObject({
      syncPluginFiles: true,
      syncEditorSettings: true,
      syncAppearance: true,
      syncThemes: true,
      syncHotkeys: true,
      syncCorePlugins: true,
      syncCommunityPlugins: true,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.mutationLedger).toEqual([]);
    expectNoFileMutations(harness.mutations);

    await reopenedSettings.updateSyncPathSettings({ syncThemes: false });
    expect(reopenedSettings).toMatchObject({
      syncThemes: false,
      syncPluginFiles: true,
      syncCommunityPlugins: true,
    });
    expect(harness.scanner.shouldSyncFolderPath(".obsidian/themes")).toBe(false);
    expect(harness.scanner.shouldSyncFolderPath(
      ".obsidian/plugins/easy-sync",
    )).toBe(true);
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    const contracted = await (reopenedSettings as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(contracted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expectNoFileMutations(harness.mutations);
    settingsPlugin.stopAutoSync();
    reopenedSettings.stopAutoSync();
    await restartedState.close();
  });

  it("filters an unconsumed scope expansion through the final contracted scope", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const finalIncludedPaths = [
      ".obsidian",
      ".obsidian/plugins",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-scopes:off",
        targetSettingsFingerprint: "easy-sync:on",
        expandedFolderPaths: expandedPaths,
        includedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "easy-sync:on",
        targetSettingsFingerprint: "community-plugins:on",
        expandedFolderPaths: [],
        includedFolderPaths: finalIncludedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [
              ".obsidian/community-plugins.json",
              ".obsidian/plugins/",
            ],
            includePluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );

    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 2,
      previousSettingsFingerprint: "plugin-scopes:off",
      targetSettingsFingerprint: "community-plugins:on",
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    expect(
      harness.state.activeSyncScopeExpansion?.folders.map((folder) => folder.path),
    ).toEqual(finalIncludedPaths);
    expectNoFileMutations(harness.mutations);
  });

  it("does not merge a continuous settings chain when the anchored identity digest changed", async () => {
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
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "config:off",
        targetSettingsFingerprint: "editor:on",
        expandedFolderPaths: [],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/app.json"],
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    const marker = harness.state.activeSyncScopeExpansion!;
    const saved = harness.pluginData["easy-sync-sync-scope-expansion"] as {
      source: { commitSeq: number; anchorFingerprint: string };
    };
    saved.source.commitSeq -= 1;
    saved.source.anchorFingerprint = "changed-identity-digest";
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "editor:on",
        targetSettingsFingerprint: "editor+themes:on",
        expandedFolderPaths: [],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/app.json"],
          }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [
              ".obsidian/app.json",
              ".obsidian/themes/",
            ],
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );

    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 2,
      previousSettingsFingerprint: "editor:on",
      targetSettingsFingerprint: "editor+themes:on",
    });
    expect(harness.state.activeSyncScopeExpansion?.createdAt)
      .toBeGreaterThanOrEqual(marker.createdAt);
    expectNoFileMutations(harness.mutations);
  });

  it("replays marker cleanup without a second state commit after the envelope already committed", async () => {
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
    vi.mocked(harness.plugin.updatePluginData).mockImplementationOnce(
      async (mutator) => {
        const candidate = { ...harness.pluginData };
        mutator(candidate);
        expect(candidate["easy-sync-sync-scope-expansion"]).toBeNull();
        throw new Error("marker clear interrupted");
      },
    );

    const interrupted = await harness.executor.run("manual");

    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    const committedSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(committedSeq);
    expectNoFileMutations(harness.mutations);
  });

  it("invalidates a persisted scope-expansion marker when its settings revision drifts", async () => {
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
    harness.pluginData["easy-sync-sync-path-settings-revision"] = 2;
    harness.pluginData["easy-sync-sync-path-settings-fingerprint"] =
      "settings:changed-again";

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stopped = await restartedExecutor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 3,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("does not rebind an existing folder anchor when the remote id was replaced out of scope", async () => {
    const originalFolder: DriveItem = {
      id: "folder-shared-old",
      name: "Shared",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-shared-old",
    };
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Shared" }],
      remoteItems: [originalFolder],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const replacement: DriveItem = {
      ...originalFolder,
      id: "folder-shared-new",
      eTag: "etag-shared-new",
    };
    harness.remoteItemState.splice(0, 1, replacement);
    await harness.state.setRemoteState(
      [],
      "https://graph.example/delta-current",
      scope,
      [{
        path: "Shared",
        driveId: replacement.id,
        parentId: scope.filesRootId,
        name: "Shared",
        eTag: replacement.eTag,
      }],
    );
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "shared:off",
        targetSettingsFingerprint: "shared:on",
        expandedFolderPaths: ["Shared"],
      },
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      errors: 0,
    });
    expect(harness.state.pendingRemoteDeletes).toContainEqual(
      expect.objectContaining({
        path: "Shared",
        requiresConfirmation: true,
      }),
    );
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: "folder-shared-old",
      lastPath: "Shared",
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: "folder-shared-new",
    }));
    expectNoFileMutations(harness.mutations);
  });

  it("keeps same-path unknown folders fail-closed without a scope-expansion authorization", async () => {
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
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 3,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expectNoFileMutations(harness.mutations);
  });

  it("reconstructs missing ancestor folder anchors from an exact confirmed descendant file", async () => {
    const {
      harness,
      pluginFolders,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    const sourceCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const deltaCalls = harness.getDelta.mock.calls.length;

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(sourceCommitSeq + 1);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 1);
    expectNoFileMutations(harness.mutations);

    const stableCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stableReconstruction = vi.spyOn(
      restartedState,
      "acceptConfirmedDescendantFolderAnchors",
    );
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(stableCommitSeq);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 2);
    expect(stableReconstruction).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("bootstraps the exact descendant file before reconstructing an unanchored folder chain", async () => {
    const {
      harness,
      pluginFolders,
      pluginFile,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
    });
    const sourceCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const deltaCalls = harness.getDelta.mock.calls.length;

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
      lastPath: pluginFile.path,
      contentHash: pluginFile.hash,
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(sourceCommitSeq + 2);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 1);
    expectNoFileMutations(harness.mutations);

    const stableCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const stableMetadataCalls =
      harness.client.getFileMetadata.mock.calls.length;
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(stableCommitSeq);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 2);
    expect(harness.client.getFileMetadata)
      .toHaveBeenCalledTimes(stableMetadataCalls);
    expectNoFileMutations(harness.mutations);
  });

  it("downloads hashless descendant evidence once before reconstructing the folder chain", async () => {
    const {
      harness,
      pluginFolders,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
      remoteContent: "{\"id\":\"easy-sync\"}",
      omitRemoteHash: true,
    });

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("reconstructs a repaired subtree file baseline in one visible sync without exposing equal files as conflicts", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      equalPaths,
      differentPaths,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      26,
      2,
    );

    const progress: Array<{ current: number; total: number }> = [];
    const repaired = await harness.executor.run("manual", {
      onProgress: (current, total) => progress.push({ current, total }),
    });

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      conflicts: 2,
      deferred: 0,
      errors: 0,
    });
    expect(repaired.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(progress).toContainEqual({ current: 26, total: 26 });
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(26);
    expect(
      harness.state.pendingConflicts.map((item) => item.path).sort(),
    ).toEqual([...differentPaths].sort());
    for (const path of equalPaths) {
      expect(harness.state.getBaseEntry(path)).toMatchObject({
        path,
        hash: harness.localEntryState.find((entry) => entry.path === path)!.hash,
      });
    }
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("uses strict SHA-256 evidence before fallback downloads and leaves a proven difference for review", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const { allPaths } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    for (let index = 0; index < 4; index++) {
      const path = allPaths[index]!;
      const remote = harness.remoteItemState.find(
        (item) => item.id === `reconstruction-file-${index}`,
      )!;
      remote.file = {
        hashes: {
          sha256Hash: harness.localEntryState.find(
            (entry) => entry.path === path,
          )!.hash,
        },
      };
    }
    harness.remoteItemState.find(
      (item) => item.id === "reconstruction-file-4",
    )!.file = { hashes: { sha256Hash: "f".repeat(64) } };
    harness.remoteItemState.find(
      (item) => item.id === "reconstruction-file-5",
    )!.file = { hashes: { quickXorHash: "same-quickxor-is-not-proof" } };

    const first = await harness.executor.run("manual");

    expect(first).toMatchObject({
      success: true,
      conflicts: 1,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(7);
    expect(harness.mutations.downloadFile).toHaveBeenCalledWith(
      "testVault",
      allPaths[5],
      undefined,
      "reconstruction-file-5",
      expect.any(Number),
    );

    expect(harness.state.pendingConflicts.map((item) => item.path))
      .toEqual([allPaths[4]]);
  });

  it("keeps large reconstruction batches in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
      0,
      1024 * 1024,
    );
    const publishEvidence = vi.spyOn(
      harness.state,
      "acceptConfirmedDescendantFileEvidence",
    );

    const first = await harness.executor.run("manual");

    expect(first).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(12);
    expect(publishEvidence).toHaveBeenCalledTimes(3);
    expect(publishEvidence.mock.calls.map(([input]) => input.entries.length))
      .toEqual([4, 4, 4]);
  });

  it("keeps slow reconstruction comparisons in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const { remoteContents } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        now += 6_000;
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const first = await harness.executor.run("manual");
    nowSpy.mockRestore();

    expect(first).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(12);
  });

  it("keeps settled reconstruction checkpoints when the single visible sync is cancelled", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      allPaths,
      remoteContents,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    let downloadCalls = 0;
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        downloadCalls++;
        if (downloadCalls === 3) harness.executor.cancel();
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const cancelled = await harness.executor.run("manual");

    expect(cancelled.message).toBe("result.cancelled");
    expect(harness.state.confirmedDescendantFileReconstruction)
      .not.toBeNull();
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(4);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) =>
        new TextEncoder().encode(remoteContents.get(path) ?? "").buffer,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );

    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    // Cancellation lets the already-started read-only verification wave finish
    // and checkpoint; restart resumes only the eight untouched candidates.
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(8);
    expect(restartedState.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("recovers an interrupted repaired-subtree baseline from durable state without redownloading settled batches", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      allPaths,
      remoteContents,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      15,
    );
    let downloadCalls = 0;
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        downloadCalls++;
        if (downloadCalls === 11) {
          throw new Error("network interrupted");
        }
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const interrupted = await harness.executor.run("manual");
    expect(interrupted).toMatchObject({
      success: false,
      deferred: 1,
      errors: 1,
      continueAfterConfirmedDescendantFileReconstruction: true,
      descendantFileReconstructionRetryableFailure: true,
    });
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(8);

    expect(harness.state.confirmedDescendantFileReconstruction)
      .not.toBeNull();
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(8);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) =>
        new TextEncoder().encode(remoteContents.get(path) ?? "").buffer,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );

    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    // The failed four-file wave is not partially published. Restart verifies
    // that whole wave again plus the final three untouched files.
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(7);
    expect(
      allPaths.filter((path) => restartedState.getBaseEntry(path)).length,
    ).toBe(15);
    expect(restartedState.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("recognizes a pre-checkpoint repaired folder cohort and closes its remaining file baseline in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const folderOnlyRepair = await harness.executor.run("manual");
    expect(folderOnlyRepair).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    const { allPaths } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      15,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();

    const reconstructed = await harness.executor.run("manual");

    expect(reconstructed).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(reconstructed.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(15);
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(15);
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

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

    expect(stopped.deferred).toBeGreaterThan(0);
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
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
      message: "result.sharedControlReadUnavailable",
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
    expect(harness.getDelta).not.toHaveBeenCalled();
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
    expect(harness.getDelta).not.toHaveBeenCalled();
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
    expect(harness.getDelta).not.toHaveBeenCalled();
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
      message: "result.ordinaryRemoteReadUnavailable",
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
    expect(harness.getDelta).not.toHaveBeenCalled();
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
      message: "result.sharedControlReadUnavailable",
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
      expect(harness.getDelta).not.toHaveBeenCalled();
      expectNoFileMutations(harness.mutations);
      await harness.state.close();
    },
  );

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
      expect(harness.getDelta).not.toHaveBeenCalled();
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
    expect(harness.getDelta).not.toHaveBeenCalled();
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
      message: "result.sharedControlReadUnavailable",
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
    expect(harness.getDelta).toHaveBeenCalledWith("testVault");
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
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);

    const resumed = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
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

    expect(recalculated.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      items: expect.arrayContaining([
        expect.objectContaining({ path: "Empty" }),
        expect.objectContaining({ path: "Later" }),
      ]),
    });
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);

    const committed = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );
    expect(committed).toMatchObject({
      success: true,
      foldersCreated: 2,
      errors: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
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
    await expect(harness.state.clearPlanReview(
      harness.state.planReviewAuthorization!,
    )).resolves.toBe(true);

    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
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
    const harness = makeHarness({ folderScanComplete: false });
    await harness.state.load();

    const result = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(1);
    expect(result.message).toBe("result.deferred");
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
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
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
    expect(restartedState.isV2StateActive).toBe(false);

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
