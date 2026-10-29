// StateManager V2 测试的共享夹具与帮手（原 tests/state-manager-v2.test.ts 前置块）。
// 拆分后由各 state-manager-v2-*.test.ts 导入；用例本身不在此文件。
import "fake-indexeddb/auto";

import { vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { getEasySyncPaths } from "../../src/obsidian-compat";
import type { PluginDataStore } from "../../src/sync/state-manager";
import type { SyncStateEnvelopeV2 } from "../../src/sync/state-envelope-v2";
import type {
  MutationIntentV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlanItem,
} from "../../src/sync/types";
import { SyncActionType } from "../../src/sync/types";
import { StateV2IndexedDbActiveStore } from "../../src/sync/state-v2-indexeddb-active";

export const paths = getEasySyncPaths(".obsidian");
export const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
export const hashA = "a".repeat(64);
export const hashB = "b".repeat(64);

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
export const folder: RemoteFolderEntry = {
  path: "Notes",
  driveId: "folder-notes",
  parentId: scope.filesRootId,
  name: "Notes",
};
export const remoteA: RemoteFileEntry = {
  path: "Notes/a.md",
  driveId: "file-a",
  parentId: folder.driveId,
  size: 10,
  mtime: 20,
  eTag: "etag-a",
  cTag: "ctag-a",
  sha256Hash: hashA,
};

export function envelope(commitSeq = 3): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 2,
      commitSeq,
      committedAt: commitSeq,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 1,
      deltaLink: "delta-1",
      complete: true,
      itemsById: {
        [folder.driveId]: {
          id: folder.driveId,
          parentId: folder.parentId,
          name: folder.name,
          kind: "folder",
        },
        [remoteA.driveId]: {
          id: remoteA.driveId,
          parentId: remoteA.parentId!,
          name: "a.md",
          kind: "file",
          size: remoteA.size,
          mtime: remoteA.mtime,
          eTag: remoteA.eTag,
          cTag: remoteA.cTag,
          contentHash: remoteA.sha256Hash,
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        "file:file-a": {
          anchorId: "file:file-a",
          remoteId: remoteA.driveId,
          lastPath: remoteA.path,
          contentHash: hashA,
          size: remoteA.size,
          remoteETag: remoteA.eTag,
          confirmedAt: 1,
          confirmedBy: "equal-read",
        },
      },
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {
        "folder:folder-notes": {
          anchorId: "folder:folder-notes",
          remoteId: folder.driveId,
          lastPath: folder.path,
          parentRemoteId: folder.parentId,
          confirmedGeneration: commitSeq,
          confirmedAt: 1,
        },
      },
    },
  };
}

/**
 * Synthetic committed envelope with `files` independent file rows under one
 * folder (plus the matching anchors and one folder anchor). Hot-path and
 * measurement tests use it when the fixture's three rows are too small for the
 * cost they are asserting on.
 */
export function wideEnvelope(files: number, commitSeq = 3): SyncStateEnvelopeV2 {
  const rows = envelope(commitSeq);
  for (let index = 0; index < files; index++) {
    const name = `wide-${String(index).padStart(5, "0")}.md`;
    const remoteId = `file-wide-${index}`;
    const path = `${folder.path}/${name}`;
    rows.remoteIndex.itemsById[remoteId] = {
      id: remoteId,
      parentId: folder.driveId,
      name,
      kind: "file",
      size: 10 + index,
      mtime: 20 + index,
      eTag: `etag-wide-${index}`,
      cTag: `ctag-wide-${index}`,
      contentHash: hashA,
    };
    rows.anchors.byAnchorId[`file:${remoteId}`] = {
      anchorId: `file:${remoteId}`,
      remoteId,
      lastPath: path,
      contentHash: hashA,
      size: 10 + index,
      remoteETag: `etag-wide-${index}`,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
  }
  return rows;
}

export function manifest(stateCommitSeq = 1) {
  return {
    schemaVersion: 2,
    activeState: "state-v2.json",
    stateCommitSeq,
    lifecycleEpoch: 2,
    scope,
    migratedAt: 1,
    legacyAutoSyncAllowed: false,
  };
}

export function makeHarness(input?: {
  pluginData?: Record<string, unknown>;
  committed?: SyncStateEnvelopeV2;
  indexedDbActive?: boolean;
  indexedDbVaultInstanceId?: string;
  readIndexedDbVaultInstanceId?: () => string | null;
  rotateIndexedDbVaultInstanceId?: () => string | null;
  diag?: PluginDataStore["diag"];
  createRemoteScopeRecoveryEvidenceStore?: NonNullable<
    PluginDataStore["createRemoteScopeRecoveryEvidenceStore"]
  >;
  indexedDbFactory?: NonNullable<
    PluginDataStore["createStateV2IndexedDbActiveStore"]
  >;
}) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const pluginData = input?.pluginData ?? {};
  let failNextFinalStateRename = false;
  let failNextIndexedDbWitnessWrite = false;
  files.set(paths.stateV2ManifestFile, JSON.stringify(manifest()));
  files.set(paths.stateV2File, JSON.stringify(input?.committed ?? envelope()));
  files.set(paths.remoteStateFile, JSON.stringify({
    version: 1,
    generation: 99,
    scope: { ...scope, driveId: "stale-drive" },
    deltaLink: "stale-delta",
    entries: {
      "stale.md": {
        path: "stale.md",
        driveId: "stale",
        parentId: scope.filesRootId,
        size: 1,
        mtime: 1,
        eTag: "stale",
        cTag: "stale",
      },
    },
    folders: {},
  }));
  const rawAdapter = {
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    readBinary: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(value).buffer;
    }),
    write: vi.fn(async (path: string, value: string) => {
      if (
        failNextIndexedDbWitnessWrite
        && path.startsWith(
          `${paths.stateV2IndexedDbRecoveryDir}/confirmed-`,
        )
        && path.endsWith(".json.next")
      ) {
        failNextIndexedDbWitnessWrite = false;
        throw new Error("indexeddb witness write failed");
      }
      files.set(path, value);
    }),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      files.set(path, new TextDecoder().decode(value));
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
      folders.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (
        failNextFinalStateRename
        && from === paths.stateV2NextFile
        && to === paths.stateV2File
      ) {
        failNextFinalStateRename = false;
        throw new Error("state rename failed");
      }
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    rmdir: vi.fn(async (path: string, recursive: boolean) => {
      const fileChildren = [...files.keys()].filter(
        (entry) => entry.startsWith(`${path}/`),
      );
      const folderChildren = [...folders].filter(
        (entry) => entry.startsWith(`${path}/`),
      );
      if (!recursive && (fileChildren.length > 0 || folderChildren.length > 0)) {
        throw new Error(`directory not empty ${path}`);
      }
      for (const entry of fileChildren) files.delete(entry);
      for (const entry of folderChildren) folders.delete(entry);
      folders.delete(path);
    }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()]
        .filter((entry) => parentPath(entry) === path)
        .sort(),
      folders: [...folders]
        .filter((entry) => parentPath(entry) === path)
        .sort(),
    })),
  };
  const adapter = rawAdapter as unknown as DataAdapter;
  // The captured Vault instance identity lives in one mutable holder so a
  // reset-time rotation can move storage, the captured property and the live
  // reader together, mirroring the plugin onload capture.
  const vaultInstanceId = {
    id: input?.indexedDbVaultInstanceId ?? "1".repeat(32),
  };
  const plugin: PluginDataStore = {
    loadData: vi.fn(async () => pluginData),
    updatePluginData: vi.fn(async (mutator) => mutator(pluginData)),
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "easy-sync", dir: paths.pluginDir },
    ...(input?.diag ? { diag: input.diag } : {}),
    ...(input?.indexedDbFactory || input?.indexedDbActive
      ? {
          indexedDbVaultInstanceId: vaultInstanceId.id,
          readIndexedDbVaultInstanceId:
            input.readIndexedDbVaultInstanceId ?? (() => vaultInstanceId.id),
          createStateV2IndexedDbActiveStore:
            input.indexedDbFactory ?? ((databaseId, recovery) =>
              new StateV2IndexedDbActiveStore(databaseId, recovery)),
        }
      : {}),
  };
  if (input?.createRemoteScopeRecoveryEvidenceStore) {
    plugin.createRemoteScopeRecoveryEvidenceStore =
      input.createRemoteScopeRecoveryEvidenceStore;
  }
  if (input?.rotateIndexedDbVaultInstanceId) {
    const generateRotatedId = input.rotateIndexedDbVaultInstanceId;
    plugin.rotateIndexedDbVaultInstanceId = () => {
      const rotated = generateRotatedId();
      if (rotated) {
        vaultInstanceId.id = rotated;
        plugin.indexedDbVaultInstanceId = rotated;
      }
      return rotated;
    };
  }
  return {
    files,
    folders,
    pluginData,
    rawAdapter,
    plugin,
    failNextStateRename: () => { failNextFinalStateRename = true; },
    failNextIndexedDbWitness: () => {
      failNextIndexedDbWitnessWrite = true;
    },
    readCommitted: () =>
      JSON.parse(files.get(paths.stateV2File)!) as SyncStateEnvelopeV2,
  };
}

export function uploadMutation(): {
  intent: MutationIntentV1;
  receipt: MutationReceiptV1;
  remote: RemoteFileEntry;
} {
  const remote: RemoteFileEntry = {
    path: "Notes/new.md",
    driveId: "file-new",
    parentId: folder.driveId,
    size: 11,
    mtime: 30,
    eTag: "etag-new",
    cTag: "ctag-new",
    sha256Hash: hashB,
  };
  const intent: MutationIntentV1 = {
    version: 1,
    operationId: "upload-new",
    planRevision: 1,
    scope,
    action: "upload",
    path: remote.path,
    expectedLocal: { exists: true, hash: hashB, size: remote.size },
    expectedRemote: { exists: false },
    createdAt: 10,
  };
  const receipt: MutationReceiptV1 = {
    version: 1,
    operationId: intent.operationId,
    completedAt: 20,
    checkpoint: {
      baseUpserts: [{
        path: remote.path,
        hash: hashB,
        size: remote.size,
        eTag: remote.eTag,
      }],
      baseRemovals: [],
      remoteUpserts: [remote],
      remoteDeletes: [],
      pendingConflictRemovals: [remote.path],
      pendingDeleteRemovals: [remote.path],
    },
  };
  return { intent, receipt, remote };
}

export function uploadMutationAt(index: number): ReturnType<typeof uploadMutation> {
  const mutation = uploadMutation();
  const path = `Notes/batch-${index}.md`;
  const driveId = `file-batch-${index}`;
  const remote = {
    ...mutation.remote,
    path,
    driveId,
    eTag: `etag-batch-${index}`,
    cTag: `ctag-batch-${index}`,
  };
  const intent: MutationIntentV1 = {
    ...mutation.intent,
    operationId: `upload-batch-${index}`,
    path,
  };
  const receipt: MutationReceiptV1 = {
    ...mutation.receipt,
    operationId: intent.operationId,
    checkpoint: {
      ...mutation.receipt.checkpoint,
      baseUpserts: [{
        path,
        hash: hashB,
        size: remote.size,
        eTag: remote.eTag,
      }],
      remoteUpserts: [remote],
      pendingConflictRemovals: [path],
      pendingDeleteRemovals: [path],
    },
  };
  return { intent, receipt, remote };
}

export function localOnlyDownloadMutation(): {
  intent: MutationIntentV1;
  receipt: MutationReceiptV1;
} {
  const intent: MutationIntentV1 = {
    version: 1,
    operationId: "restore-generation-main",
    planRevision: 4,
    scope,
    action: "download",
    path: ".obsidian/plugins/example/main.js",
    sourcePath: `.easy-sync/community-plugin-content-v1/objects/${hashB}.bin`,
    stateEffect: "local-only",
    expectedLocal: { exists: false },
    expectedRemote: {
      exists: true,
      driveId: "generation-object-main",
      eTag: "etag-generation-main",
      size: 11,
      sha256Hash: hashB,
    },
    createdAt: 10,
  };
  return {
    intent,
    receipt: {
      version: 1,
      operationId: intent.operationId,
      completedAt: 20,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    },
  };
}

export function pluginBundleConflict(): SyncPlanItem {
  const path = ".obsidian/plugins/resojot/manifest.json";
  return {
    type: SyncActionType.Conflict,
    path,
    local: { path, hash: hashA, size: 20, mtime: 20 },
    remote: {
      path,
      driveId: "remote-resojot-manifest",
      parentId: "remote-resojot-root",
      size: 24,
      mtime: 30,
      eTag: "etag-resojot-manifest",
      cTag: "ctag-resojot-manifest",
      sha256Hash: hashB,
    },
    decisionToken: {
      version: 1,
      vaultName: "vault",
      accountId: scope.accountId,
      scope,
      local: { exists: true, hash: hashA, size: 20 },
      remote: {
        exists: true,
        driveId: "remote-resojot-manifest",
        eTag: "etag-resojot-manifest",
      },
      ancestorHash: null,
    },
  };
}

export function pluginBundleSettlementEntry(
  predecessorIntent: MutationIntentV1,
  conflict: SyncPlanItem,
): MutationLedgerEntryV1 {
  const pluginRoot = ".obsidian/plugins/resojot";
  const anchorIntent: MutationIntentV1 = {
    version: 1,
    operationId: "bundle-resojot-keep-remote",
    planRevision: 3,
    scope,
    action: "download",
    path: pluginRoot,
    stateEffect: "settlement-only",
    expectedLocal: { exists: false },
    expectedRemote: { exists: false },
    createdAt: 40,
  };
  return {
    intent: anchorIntent,
    receipt: null,
    manualResolution: {
      version: 2,
      kind: "community-plugin-bundle-settlement",
      choice: "keep-remote",
      factsDigest: "d".repeat(64),
      selectedAt: 40,
      externalMutation: true,
      intent: anchorIntent,
      receipt: null,
      pluginId: "resojot",
      pluginRoot,
      predecessorOperationIds: [predecessorIntent.operationId],
      conflictDecisions: [{
        path: conflict.path,
        decisionToken: conflict.decisionToken,
      }],
      members: [
        {
          intent: {
            version: 1,
            operationId: "bundle-resojot-main-download",
            planRevision: 3,
            scope,
            action: "download",
            path: `${pluginRoot}/main.js`,
            stateEffect: "bundle-settlement",
            expectedLocal: predecessorIntent.expectedLocal,
            expectedRemote: {
              exists: true,
              driveId: "remote-resojot-main",
              eTag: "etag-resojot-main",
              size: 11,
              sha256Hash: hashA,
            },
            createdAt: 40,
          },
          receipt: null,
        },
        {
          intent: {
            version: 1,
            operationId: "bundle-resojot-manifest-download",
            planRevision: 3,
            scope,
            action: "download",
            path: conflict.path,
            stateEffect: "bundle-settlement",
            expectedLocal: conflict.decisionToken!.local,
            expectedRemote: conflict.remote
              ? {
                  exists: true,
                  driveId: conflict.remote.driveId,
                  eTag: conflict.remote.eTag,
                  size: conflict.remote.size,
                  sha256Hash: conflict.remote.sha256Hash!,
                }
              : { exists: false },
            createdAt: 40,
          },
          receipt: null,
        },
      ],
    },
  };
}

export function keepLocalPluginBundleSettlementEntry(
  predecessorIntent: MutationIntentV1,
  conflict: SyncPlanItem,
): MutationLedgerEntryV1 {
  const entry = pluginBundleSettlementEntry(predecessorIntent, conflict);
  const settlement = entry.manualResolution;
  if (!settlement || settlement.version !== 2) throw new Error("bundle fixture missing");
  const anchorIntent: MutationIntentV1 = {
    ...settlement.intent,
    operationId: "bundle-resojot-keep-local",
    action: "upload",
  };
  return {
    intent: anchorIntent,
    receipt: null,
    manualResolution: {
      ...settlement,
      choice: "keep-local",
      intent: anchorIntent,
      members: settlement.members.map((member) => ({
        ...member,
        intent: {
          ...member.intent,
          operationId: member.intent.operationId.replace("download", "upload"),
          action: "upload",
        },
      })),
    },
  };
}

export function pluginBundleEnvelope(): SyncStateEnvelopeV2 {
  const current = envelope();
  const folders = [
    { id: "folder-config", parentId: scope.filesRootId, name: ".obsidian" },
    { id: "folder-plugins", parentId: "folder-config", name: "plugins" },
    { id: "remote-resojot-root", parentId: "folder-plugins", name: "resojot" },
  ];
  for (const entry of folders) {
    current.remoteIndex.itemsById[entry.id] = {
      ...entry,
      kind: "folder",
    };
  }
  current.remoteIndex.itemsById["remote-resojot-main"] = {
    id: "remote-resojot-main",
    parentId: "remote-resojot-root",
    name: "main.js",
    kind: "file",
    size: 11,
    mtime: 30,
    eTag: "etag-resojot-main",
    cTag: "ctag-resojot-main",
    contentHash: hashA,
  };
  current.remoteIndex.itemsById["remote-resojot-manifest"] = {
    id: "remote-resojot-manifest",
    parentId: "remote-resojot-root",
    name: "manifest.json",
    kind: "file",
    size: 24,
    mtime: 30,
    eTag: "etag-resojot-manifest",
    cTag: "ctag-resojot-manifest",
    contentHash: hashB,
  };
  return current;
}

export function receiptedPluginBundleSettlementEntry(
  predecessorIntent: MutationIntentV1,
  conflict: SyncPlanItem,
): MutationLedgerEntryV1 {
  const entry = pluginBundleSettlementEntry(predecessorIntent, conflict);
  const settlement = entry.manualResolution;
  if (!settlement || settlement.version !== 2) throw new Error("bundle fixture missing");
  const remoteByPath = new Map<string, RemoteFileEntry>([
    [".obsidian/plugins/resojot/main.js", {
      path: ".obsidian/plugins/resojot/main.js",
      driveId: "remote-resojot-main",
      parentId: "remote-resojot-root",
      size: 11,
      mtime: 30,
      eTag: "etag-resojot-main",
      cTag: "ctag-resojot-main",
      sha256Hash: hashA,
    }],
    [".obsidian/plugins/resojot/manifest.json", {
      path: ".obsidian/plugins/resojot/manifest.json",
      driveId: "remote-resojot-manifest",
      parentId: "remote-resojot-root",
      size: 24,
      mtime: 30,
      eTag: "etag-resojot-manifest",
      cTag: "ctag-resojot-manifest",
      sha256Hash: hashB,
    }],
  ]);
  return {
    ...entry,
    manualResolution: {
      ...settlement,
      members: settlement.members.map((member, index) => {
        const remote = remoteByPath.get(member.intent.path)!;
        return {
          ...member,
          receipt: {
            version: 1,
            operationId: member.intent.operationId,
            completedAt: 50 + index,
            checkpoint: {
              baseUpserts: [{
                path: remote.path,
                hash: remote.sha256Hash!,
                size: remote.size,
                eTag: remote.eTag,
              }],
              baseRemovals: [],
              remoteUpserts: [remote],
              remoteDeletes: [],
              pendingConflictRemovals: [],
              pendingDeleteRemovals: [],
            },
          },
        };
      }),
    },
  };
}
