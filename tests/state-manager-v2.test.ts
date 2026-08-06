import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { deleteDB, openDB } from "idb";
import { sha256Hex } from "../src/crypto";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type {
  FolderMutationIntentV2,
  ManualMutationResolutionV1,
  MutationIntentV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlanItem,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";
import {
  StateV2IndexedDbActiveStore,
  stateV2ActiveIndexedDbDatabaseName,
} from "../src/sync/state-v2-indexeddb-active";

const paths = getEasySyncPaths(".obsidian");
const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
const folder: RemoteFolderEntry = {
  path: "Notes",
  driveId: "folder-notes",
  parentId: scope.filesRootId,
  name: "Notes",
};
const remoteA: RemoteFileEntry = {
  path: "Notes/a.md",
  driveId: "file-a",
  parentId: folder.driveId,
  size: 10,
  mtime: 20,
  eTag: "etag-a",
  cTag: "ctag-a",
  sha256Hash: hashA,
};

function envelope(commitSeq = 3): SyncStateEnvelopeV2 {
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

function manifest(stateCommitSeq = 1) {
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

function makeHarness(input?: {
  pluginData?: Record<string, unknown>;
  committed?: SyncStateEnvelopeV2;
  indexedDbActive?: boolean;
  indexedDbVaultInstanceId?: string;
  readIndexedDbVaultInstanceId?: () => string | null;
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
  const plugin: PluginDataStore = {
    loadData: vi.fn(async () => pluginData),
    updatePluginData: vi.fn(async (mutator) => mutator(pluginData)),
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "easy-sync", dir: paths.pluginDir },
    ...(input?.indexedDbFactory || input?.indexedDbActive
      ? {
          indexedDbVaultInstanceId:
            input.indexedDbVaultInstanceId ?? "1".repeat(32),
          readIndexedDbVaultInstanceId:
            input.readIndexedDbVaultInstanceId
            ?? (() => input.indexedDbVaultInstanceId ?? "1".repeat(32)),
          createStateV2IndexedDbActiveStore:
            input.indexedDbFactory ?? ((databaseId, recovery) =>
              new StateV2IndexedDbActiveStore(databaseId, recovery)),
        }
      : {}),
  };
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

function uploadMutation(): {
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

describe("StateManager V2 production controller", () => {
  it("owns device community-plugin participation in active IndexedDB across restart", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let restarted: StateManager | null = null;
    let databaseId = "";
    try {
      await state.load();
      databaseId = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ).storageAuthority.databaseId as string;

      const migrated = await state.initializeCommunityPluginParticipation({
        filesEnabled: true,
        selection: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["restore-me"],
        },
        knownPluginIds: ["installed", "remote-only", "restore-me"],
        completeLocalBundlePluginIds: ["installed"],
      }, 10);

      expect(migrated.changed).toBe(true);
      expect(state.getCommunityPluginParticipation()).toMatchObject({
        scopeEnabled: true,
        pluginsById: {
          installed: { phase: "participating" },
          "remote-only": { phase: "never-participated" },
          "restore-me": { phase: "join-requested" },
        },
      });
      expect(harness.readCommitted().communityPluginParticipation).toBeUndefined();
      expect(state.activeV2StorageAuthorityEvidence?.kind).toBe("indexeddb");

      await state.close();
      restarted = new StateManager(harness.plugin);
      await restarted.load();
      expect(restarted.getCommunityPluginParticipation()).toEqual(
        state.getCommunityPluginParticipation(),
      );

      await restarted.updateCommunityPluginParticipation({
        type: "request-join",
        pluginId: "remote-only",
        operationId: "join-remote-only",
      }, 11);
      expect(
        restarted.getCommunityPluginParticipation()
          ?.pluginsById["remote-only"],
      ).toMatchObject({
        phase: "join-requested",
        operationId: "join-remote-only",
      });

      await restarted.updateCommunityPluginParticipationBatch([{
        type: "set-scope-enabled",
        enabled: false,
      }, {
        type: "confirm-excluded",
        pluginId: "installed",
      }], 12);
      expect(restarted.getCommunityPluginParticipation()).toMatchObject({
        scopeEnabled: false,
        pluginsById: {
          installed: { phase: "excluded" },
          "remote-only": { phase: "join-requested" },
        },
      });

      const beforeRejectedBatch =
        restarted.getCommunityPluginParticipation();
      await expect(restarted.updateCommunityPluginParticipationBatch([{
        type: "set-scope-enabled",
        enabled: true,
      }, {
        type: "block",
        pluginId: "installed",
        reason: " ",
      }], 13)).rejects.toThrow(
        "Device community-plugin blocked reason is required",
      );
      expect(restarted.getCommunityPluginParticipation()).toEqual(
        beforeRejectedBatch,
      );
    } finally {
      await (restarted ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("exposes only complete current-account V2 folders to one exclusion session", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();

    await expect(
      state.createSyncExclusionFolderSnapshot(scope.accountId),
    ).resolves.toEqual({
      hadPendingReview: false,
      remoteFolderPaths: ["Notes"],
    });
    await expect(
      state.createSyncExclusionFolderSnapshot("other-account"),
    ).resolves.toEqual({
      hadPendingReview: false,
      remoteFolderPaths: [],
    });

    await state.setPlanReviewBundle(
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
      {
        version: 2,
        scope,
        sourceCommitSeq: state.getCommittedV2Envelope()!.meta.commitSeq - 1,
        digest: "stale-review",
      },
    );
    await expect(
      state.createSyncExclusionFolderSnapshot(scope.accountId),
    ).resolves.toEqual({
      hadPendingReview: true,
      remoteFolderPaths: [],
    });
  });

  it("fails closed when the committed V2 remote folder tree is incomplete", async () => {
    const committed = envelope();
    (committed.remoteIndex as { complete: boolean }).complete = false;
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();

    await expect(
      state.createSyncExclusionFolderSnapshot(scope.accountId),
    ).resolves.toEqual({
      hadPendingReview: false,
      remoteFolderPaths: [],
    });
  });

  it("publishes new common text to AncestorStoreV2 and reads it only through the anchor", async () => {
    const content = "next common text\n";
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256Hex(bytes);
    const committed = envelope();
    const node = committed.remoteIndex.itemsById[remoteA.driveId]!;
    if (node.kind !== "file") throw new Error("fixture remote must be a file");
    node.contentHash = hash;
    node.size = bytes.byteLength;
    node.eTag = "etag-next";
    const anchor = committed.anchors.byAnchorId["file:file-a"]!;
    anchor.contentHash = hash;
    anchor.size = bytes.byteLength;
    anchor.remoteETag = node.eTag;
    delete anchor.ancestorHash;
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();

    state.cacheBaseContent(remoteA.path, content);
    const ancestorHashes = await state.upsertBaseEntries([{
      path: remoteA.path,
      hash,
      size: bytes.byteLength,
      eTag: node.eTag!,
    }]);

    expect(ancestorHashes).toEqual({ [remoteA.path]: hash });
    const reloaded = harness.readCommitted();
    expect(reloaded.anchors.byAnchorId["file:file-a"]).toMatchObject({
      contentHash: hash,
      ancestorHash: hash,
    });
    expect(
      harness.files.get(`${paths.ancestorsV2Dir}/${hash}.txt`),
    ).toBe(content);
    await expect(state.getBaseContent(remoteA.path)).resolves.toBe(content);
    expect(harness.rawAdapter.write.mock.calls.some(
      ([path]) => path === paths.baseContentFile,
    )).toBe(false);
  });

  it("commits a proven remote scope recovery candidate and invalidates old decisions", async () => {
    const targetScope = {
      ...scope,
      vaultFolderId: "vault-recovered",
      filesRootId: "root-recovered",
    };
    const held: SyncStateEnvelopeV2 = {
      ...envelope(4),
      remoteScopeRecovery: {
        schemaVersion: 1,
        kind: "v2-remote-scope-recovery",
        reason: "committed-scope-unreachable",
        sourceCommitSeq: 3,
        observedScope: targetScope,
        observedAt: 4,
      },
    };
    const candidate: SyncStateEnvelopeV2 = {
      meta: {
        schemaVersion: 2,
        lifecycleEpoch: 3,
        commitSeq: 5,
        committedAt: 5,
      },
      scope: targetScope,
      remoteIndex: {
        schemaVersion: 2,
        filesRootId: targetScope.filesRootId,
        cursorRevision: 2,
        deltaLink: "delta-recovered",
        complete: true,
        itemsById: {},
      },
      anchors: { schemaVersion: 2, byAnchorId: {} },
      folderAnchors: { schemaVersion: 2, byAnchorId: {} },
    };
    const harness = makeHarness({
      committed: held,
      indexedDbActive: true,
      pluginData: {
        "easy-sync-plan-review-active": true,
        "easy-sync-plan-review-revision": 2,
        "easy-sync-pending-conflicts": [{
          type: "conflict",
          path: "old.md",
        }],
        "easy-sync-local-folder-move-hints": [{
          version: 1,
          scope,
          remoteId: "old-folder",
          fromPath: "old",
          toPath: "new",
          observedAt: 1,
        }],
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();

    const committed = await state.commitV2RemoteScopeRecoveryCandidate(
      candidate,
      100,
    );

    expect(committed).toEqual(candidate);
    expect(state.remoteScope).toEqual(targetScope);
    expect(state.hasV2RemoteScopeRecovery).toBe(false);
    expect(state.planReviewActive).toBe(false);
    expect(state.pendingConflicts).toEqual([]);
    expect(state.localFolderMoveHints).toEqual([]);
    expect(JSON.parse(
      harness.files.get(paths.stateV2ManifestFile)!,
    )).toMatchObject({
      scope: targetScope,
      stateCommitSeq: 5,
      lifecycleEpoch: 3,
    });
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      revision: 5,
      status: "active",
      storageAuthority: {
        kind: "indexeddb",
        stateCommitSeq: 5,
      },
      manifest: {
        scope: targetScope,
        stateCommitSeq: 5,
      },
    });
    expect(harness.files.has(paths.stateV2ScopeTransitionFile)).toBe(false);
    const targetWitness = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    await state.close();
    await deleteDB(stateV2ActiveIndexedDbDatabaseName(
      targetWitness.storageAuthority.databaseId,
    ));
  });

  it("uses the manifest-selected envelope as the only file-state authority", async () => {
    const staleBase = {
      path: "stale.md",
      hash: "c".repeat(64),
      size: 1,
      eTag: "stale",
    };
    const harness = makeHarness({
      pluginData: { "easy-sync-base-snapshot": { "stale.md": staleBase } },
    });
    harness.files.set(paths.baseContentFile, JSON.stringify({
      "stale.md": "legacy ancestor must not load under V2",
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.isV2StateActive).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.baseSnapshot).toEqual([{
      path: remoteA.path,
      hash: hashA,
      size: remoteA.size,
      eTag: remoteA.eTag,
    }]);
    expect(state.remoteSnapshot).toEqual([remoteA]);
    expect(state.remoteFolders).toEqual([folder]);
    expect(state.remoteDeltaLink).toBe("delta-1");
    expect(state.remoteScope).toEqual(scope);
    expect(harness.rawAdapter.read.mock.calls.some(
      ([path]) => path === paths.baseContentFile,
    )).toBe(false);
  });

  it("publishes remote refreshes and base confirmations only to the V2 envelope", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    harness.rawAdapter.write.mockClear();
    const updatedRemote = {
      ...remoteA,
      eTag: "etag-a-2",
      cTag: "ctag-a-2",
    };

    await state.setRemoteState([updatedRemote], "delta-2", scope, [folder]);
    await state.upsertBaseEntries([{
      path: updatedRemote.path,
      hash: hashA,
      size: updatedRemote.size,
      eTag: updatedRemote.eTag,
    }]);
    const committed = harness.readCommitted();
    const committedSeq = committed.meta.commitSeq;
    await state.setRemoteState(
      [{ ...updatedRemote, downloadUrl: "https://volatile.example/a" }],
      "delta-2",
      scope,
      [folder],
    );

    expect(state.remoteDeltaLink).toBe("delta-2");
    expect(state.baseSnapshot[0]?.eTag).toBe("etag-a-2");
    expect(harness.readCommitted().meta.commitSeq).toBe(committedSeq);
    expect(harness.rawAdapter.write.mock.calls.some(
      ([path]) => path === paths.remoteStateFile,
    )).toBe(false);
    expect((harness.pluginData["easy-sync-base-snapshot"] as object | undefined))
      .toBeUndefined();
  });

  it("commits one equal eTag refresh while preserving another divergent base", async () => {
    const committed = envelope();
    const remoteB: RemoteFileEntry = {
      path: "Notes/b.md",
      driveId: "file-b",
      parentId: folder.driveId,
      size: 12,
      mtime: 21,
      eTag: "etag-b",
      cTag: "ctag-b",
      sha256Hash: hashB,
    };
    committed.remoteIndex.itemsById[remoteB.driveId] = {
      id: remoteB.driveId,
      parentId: remoteB.parentId!,
      name: "b.md",
      kind: "file",
      size: remoteB.size,
      mtime: remoteB.mtime,
      eTag: remoteB.eTag,
      cTag: remoteB.cTag,
      contentHash: remoteB.sha256Hash,
    };
    committed.anchors.byAnchorId["file:file-b"] = {
      anchorId: "file:file-b",
      remoteId: remoteB.driveId,
      lastPath: remoteB.path,
      contentHash: hashB,
      size: remoteB.size,
      remoteETag: remoteB.eTag,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();

    const refreshedA = {
      ...remoteA,
      eTag: "etag-a-2",
      cTag: "ctag-a-2",
    };
    const changedB = {
      ...remoteB,
      eTag: "etag-b-2",
      cTag: "ctag-b-2",
      sha256Hash: "c".repeat(64),
    };
    await state.setRemoteState(
      [refreshedA, changedB],
      "delta-2",
      scope,
      [folder],
    );
    await state.upsertBaseEntries([{
      path: refreshedA.path,
      hash: hashA,
      size: refreshedA.size,
      eTag: refreshedA.eTag,
    }]);

    expect(state.baseSnapshot).toEqual([
      {
        path: refreshedA.path,
        hash: hashA,
        size: refreshedA.size,
        eTag: refreshedA.eTag,
      },
      {
        path: remoteB.path,
        hash: hashB,
        size: remoteB.size,
        eTag: remoteB.eTag,
      },
    ]);
    expect(harness.readCommitted().anchors.byAnchorId["file:file-b"])
      .toMatchObject({
        contentHash: hashB,
        remoteETag: remoteB.eTag,
        confirmedAt: 1,
      });
  });

  it("does not expose a V2 to V1 downgrade state API", async () => {
    const harness = makeHarness({
      pluginData: {
        "easy-sync-base-snapshot": {
          "stale.md": {
            path: "stale.md",
            hash: "c".repeat(64),
            size: 1,
            eTag: "stale",
          },
        },
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();

    expect((state as unknown as Record<string, unknown>).downgradeV2FileState)
      .toBeUndefined();
    expect(state.isV2StateActive).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.remoteScope).toEqual(scope);
    expect(state.remoteSnapshot).toEqual([remoteA]);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RetiredManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);
  });

  it("stages an unreachable remote scope inside V2 without rewriting anchors or V1 state", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const replacementScope = {
      ...scope,
      vaultFolderId: "replacement-vault",
      filesRootId: "replacement-root",
    };

    await expect(state.stageV2RemoteScopeRecovery({
      observedScope: replacementScope,
      now: 60,
    })).resolves.toMatchObject({
      kind: "v2-remote-scope-recovery",
      reason: "committed-scope-unreachable",
      sourceCommitSeq: 3,
      observedScope: replacementScope,
    });

    expect(state.isV2StateActive).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.remoteScope).toEqual(scope);
    expect(state.remoteSnapshot).toEqual([remoteA]);
    expect(state.activeV2RemoteScopeRecovery).toMatchObject({
      sourceCommitSeq: 3,
      observedScope: replacementScope,
    });
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RetiredManifestFile)).toBe(false);
    await expect(state.setRemoteState([], null, scope, []))
      .rejects.toThrow("during remote scope recovery");

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.isV2StateActive).toBe(true);
    expect(restarted.activeV2RemoteScopeRecovery).toEqual(
      state.activeV2RemoteScopeRecovery,
    );
    expect(restarted.remoteScope).toEqual(scope);
  });

  it("makes scope-recovery staging idempotent and rejects ambiguous observations or unresolved mutations", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const replacementScope = {
      ...scope,
      vaultFolderId: "replacement-vault",
      filesRootId: "replacement-root",
    };
    const first = await state.stageV2RemoteScopeRecovery({
      observedScope: replacementScope,
      now: 60,
    });
    const committedSeq = harness.readCommitted().meta.commitSeq;

    await expect(state.stageV2RemoteScopeRecovery({
      observedScope: replacementScope,
      now: 70,
    })).resolves.toEqual(first);
    expect(harness.readCommitted().meta.commitSeq).toBe(committedSeq);
    await expect(state.stageV2RemoteScopeRecovery({
      observedScope: null,
    })).rejects.toThrow("observation changed");

    for (const observedScope of [
      scope,
      { ...replacementScope, accountId: "other-account" },
    ]) {
      const invalidHarness = makeHarness();
      const invalidState = new StateManager(invalidHarness.plugin);
      await invalidState.load();
      await expect(invalidState.stageV2RemoteScopeRecovery({
        observedScope,
      })).rejects.toThrow("observation is invalid");
      expect(invalidState.hasV2RemoteScopeRecovery).toBe(false);
      expect(invalidHarness.readCommitted().meta.commitSeq).toBe(3);
    }

    const mutation = uploadMutation();
    const ledgerHarness = makeHarness({
      pluginData: {
        "easy-sync-mutation-ledger": [{
          intent: mutation.intent,
          receipt: mutation.receipt,
        }],
      },
    });
    const ledgerState = new StateManager(ledgerHarness.plugin);
    await ledgerState.load();
    expect(ledgerHarness.pluginData["easy-sync-mutation-ledger"])
      .toEqual([]);
    expect(ledgerHarness.pluginData["easy-sync-v2-mutation-ledger"])
      .toEqual([{
        intent: mutation.intent,
        receipt: mutation.receipt,
      }]);
    await expect(ledgerState.stageV2RemoteScopeRecovery({
      observedScope: replacementScope,
    })).rejects.toThrow("mutation recovery is unresolved");
    expect(ledgerState.hasV2RemoteScopeRecovery).toBe(false);
  });

  it("refreshes a held GET-only scope observation without changing V2 authority", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const replacementScope = {
      ...scope,
      vaultFolderId: "replacement-vault",
      filesRootId: "replacement-root",
    };
    await state.stageV2RemoteScopeRecovery({
      observedScope: null,
      now: 60,
    });
    const heldSeq = harness.readCommitted().meta.commitSeq;

    const refreshed = await state.refreshV2RemoteScopeRecoveryObservation({
      observedScope: replacementScope,
      now: 70,
    });

    expect(refreshed).toEqual(expect.objectContaining({
      sourceCommitSeq: heldSeq,
      observedScope: replacementScope,
      observedAt: 70,
    }));
    expect(harness.readCommitted()).toMatchObject({
      meta: { commitSeq: heldSeq + 1 },
      scope,
      remoteScopeRecovery: refreshed,
    });
    expect(state.remoteScope).toEqual(scope);
    expect(state.remoteSnapshot).toEqual([remoteA]);

    await expect(state.refreshV2RemoteScopeRecoveryObservation({
      observedScope: replacementScope,
      now: 80,
    })).resolves.toEqual(refreshed);
    expect(harness.readCommitted().meta.commitSeq).toBe(heldSeq + 1);
    await expect(state.refreshV2RemoteScopeRecoveryObservation({
      observedScope: scope,
    })).rejects.toThrow("refresh observation is invalid");
  });

  it("blocks when legacy-active and V2 mutation ledgers disagree", async () => {
    const first = uploadMutation();
    const second = uploadMutation();
    second.intent.operationId = "operation-other";
    second.receipt.operationId = second.intent.operationId;
    const harness = makeHarness({
      pluginData: {
        "easy-sync-mutation-ledger": [{
          intent: first.intent,
          receipt: first.receipt,
        }],
        "easy-sync-v2-mutation-ledger": [{
          intent: second.intent,
          receipt: second.receipt,
        }],
      },
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.isV2StateActive).toBe(true);
    expect(state.hasMutationLedgerCorruption).toBe(true);
    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "v2-mutation-ledger-migration-failed",
    });
  });

  it("clears every local V2 baseline and record while preserving logs, settings carriers, plugin assets, and user files", async () => {
    const harness = makeHarness({
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-history": [{
          id: "history-1",
          mode: "manual",
          status: "success",
          startedAt: 1,
          endedAt: 2,
          uploaded: 0,
          downloaded: 0,
          deleted: 0,
          conflicts: 0,
          skipped: 0,
          errors: 0,
          message: "done",
          files: [],
        }],
        "sync-interval": 15,
        "easy-sync-diagnostic-log": true,
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      expect(databaseId).not.toBe("");

      harness.folders.add(paths.ancestorsV2Dir);
      harness.folders.add(paths.stateV2IndexedDbRecoveryDir);
      harness.folders.add(paths.tmpDir);
      harness.folders.add(paths.logsDir);
      harness.files.set(`${paths.ancestorsV2Dir}/${hashA}.txt`, "ancestor");
      harness.files.set(`${paths.stateV2IndexedDbRecoveryDir}/prepared.json`, "{}");
      harness.files.set(`${paths.tmpDir}/downloads/note.md.part`, "partial");
      harness.files.set(`${paths.logsDir}/2026-08-04.jsonl`, "diagnostic");
      harness.files.set(paths.baseContentFile, JSON.stringify({ "note.md": "base" }));
      harness.files.set(paths.stateV1BackupFile, "{}");
      harness.files.set(paths.scanCacheFile, "{}");
      harness.files.set(`${paths.stateV2CorruptSourcePrefix}1.json`, "{}");
      harness.files.set(`${paths.stateV2ReactivationArchivePrefix}1.json`, "{}");
      harness.files.set(`${paths.pluginDir}/main.js`, "plugin");
      harness.files.set("Notes/user.md", "user");

      await state.reset();

      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.remoteGeneration).toBe(0);
      expect(state.boundAccountId).toBe("");
      expect(state.baseSnapshot).toEqual([]);
      expect(state.remoteSnapshot).toEqual([]);
      expect(state.pendingConflicts).toEqual([]);
      expect(state.pendingRemoteDeletes).toEqual([]);
      expect(state.pendingIssues).toEqual([]);
      expect(state.syncHistory).toEqual([]);
      expect(harness.files.get(`${paths.logsDir}/2026-08-04.jsonl`))
        .toBe("diagnostic");
      expect(harness.files.get(`${paths.pluginDir}/main.js`)).toBe("plugin");
      expect(harness.files.get("Notes/user.md")).toBe("user");
      expect(harness.pluginData["sync-interval"]).toBe(15);
      expect(harness.pluginData["easy-sync-diagnostic-log"]).toBe(true);
      expect([...harness.files.keys()].filter((path) =>
        path.startsWith(`${paths.pluginDir}/state-v2`)
        || path === paths.remoteStateFile
        || path === paths.baseContentFile
        || path === paths.stateV1BackupFile
        || path === paths.scanCacheFile
        || path.startsWith(`${paths.ancestorsV2Dir}/`)
        || path.startsWith(`${paths.tmpDir}/`)
      )).toEqual([]);
      expect((await indexedDB.databases()).map((entry) => entry.name))
        .not.toContain(stateV2ActiveIndexedDbDatabaseName(databaseId));
      expect(harness.rawAdapter.rmdir).not.toHaveBeenCalledWith(
        paths.logsDir,
        true,
      );
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("finishes an explicit reset when a previous attempt already removed the V2 manifest", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const active = new StateManager(harness.plugin);
    let databaseId = "";
    let retry: StateManager | null = null;
    try {
      await active.load();
      databaseId = active.activeV2StorageAuthorityEvidence.databaseId ?? "";
      await active.close();
      harness.files.delete(paths.stateV2ManifestFile);

      retry = new StateManager(harness.plugin);
      await retry.load();
      expect(retry.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "authority-witness-manifest-missing",
      });

      await retry.reset();

      expect(retry.v2StateLoadRecoveryBlock).toBeNull();
      expect(retry.isV2StateActive).toBe(false);
      expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
      expect((await indexedDB.databases()).map((entry) => entry.name))
        .not.toContain(stateV2ActiveIndexedDbDatabaseName(databaseId));
    } finally {
      await (retry ?? active).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("clears a scope hold only from a proof of the exact committed scope", async () => {
    const harness = makeHarness({
      pluginData: {
        "easy-sync-pending-conflicts": [{ path: "old.md" }],
        "easy-sync-pending-deletes": [{ path: "deleted.md" }],
        "easy-sync-pending-issues": [{ path: "issue.md" }],
        "easy-sync-local-folder-move-hints": [{ from: "A", to: "B" }],
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    const replacementScope = {
      ...scope,
      vaultFolderId: "replacement-vault",
      filesRootId: "replacement-root",
    };
    await state.stageV2RemoteScopeRecovery({
      observedScope: replacementScope,
      now: 60,
    });
    const heldSeq = harness.readCommitted().meta.commitSeq;

    await expect(state.resolveV2RemoteScopeRecoveryToCommittedScope(
      replacementScope,
      70,
    )).rejects.toThrow("restoration proof is not safe");
    const resolved = await state.resolveV2RemoteScopeRecoveryToCommittedScope(
      scope,
      80,
    );

    expect(resolved.meta.commitSeq).toBe(heldSeq + 1);
    expect(resolved.remoteScopeRecovery).toBeUndefined();
    expect(state.hasV2RemoteScopeRecovery).toBe(false);
    expect(state.remoteScope).toEqual(scope);
    expect(state.pendingConflicts).toEqual([]);
    expect(state.pendingRemoteDeletes).toEqual([]);
    expect(state.pendingIssues).toEqual([]);
    expect(state.localFolderMoveHints).toEqual([]);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.isV2StateActive).toBe(true);
    expect(restarted.hasV2RemoteScopeRecovery).toBe(false);
    expect(restarted.remoteScope).toEqual(scope);
  });

  it("persists scope bootstrap review before confirming create-only authority", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    await state.stageV2RemoteScopeRecovery({
      observedScope: null,
      now: 60,
    });

    const staged = await state.stageV2RemoteScopeBootstrapReview(70);
    expect(staged.remoteScopeRecovery?.scopeBootstrap).toEqual({
      schemaVersion: 1,
      kind: "v2-remote-scope-bootstrap-review",
      phase: "pending",
      reviewSourceCommitSeq: staged.meta.commitSeq,
      requestedAt: 70,
    });
    const items = [{
      type: SyncActionType.RecreateRemoteScope,
      path: "testVault",
      reason: "reason.remoteScopeRecreate",
      reviewImpactCount: 1,
    }];
    const identity = {
      version: 2 as const,
      scope,
      sourceCommitSeq: staged.meta.commitSeq,
      digest: canonicalPlanDigestV2({
        items,
        lastTotalFiles: 1,
        scope,
        sourceCommitSeq: staged.meta.commitSeq,
      }),
    };
    await state.setPlanReviewBundle(
      items,
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
    const authorization = state.planReviewAuthorization;
    expect(authorization).not.toBeNull();

    const confirmed = await state.confirmV2RemoteScopeBootstrapReview(
      authorization!,
      80,
    );

    expect(confirmed.remoteScopeRecovery?.scopeBootstrap).toMatchObject({
      phase: "confirmed",
      reviewSourceCommitSeq: staged.meta.commitSeq,
      requestedAt: 70,
      confirmedAt: 80,
    });
    expect(confirmed.meta.commitSeq).toBe(staged.meta.commitSeq + 1);
    expect(state.planReviewActive).toBe(false);
    expect(state.hasV2RemoteScopeRecovery).toBe(true);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(
      restarted.activeV2RemoteScopeRecovery?.scopeBootstrap?.phase,
    ).toBe("confirmed");
    expect(restarted.planReviewActive).toBe(false);
  });

  it("atomically quarantines an unreachable upload receipt while V2 remains authoritative", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    await state.beginMutationIntent(mutation.intent);
    await state.recordMutationReceipt(mutation.receipt);
    expect(harness.pluginData["easy-sync-mutation-ledger"]).toEqual([]);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"])
      .toEqual([{
        intent: mutation.intent,
        receipt: mutation.receipt,
      }]);

    await expect(state.quarantineUnreachableUploadReceipt({
      record: {
        intent: mutation.intent,
        receipt: mutation.receipt,
      },
      remoteId: mutation.remote.driveId,
      localMissing: true,
      graphItemMissing: true,
      now: 70,
    })).resolves.toMatchObject({
      version: 2,
      kind: "mutation-recovery-quarantine",
      operationId: mutation.intent.operationId,
      reason: "receipted-upload-version-unreachable",
      quarantinedAt: 70,
      scope,
      sourceCommitSeq: 3,
      remoteId: mutation.remote.driveId,
      evidence: {
        localMissing: true,
        completeRemoteIndex: true,
        remotePathMissing: true,
        remoteIdMissing: true,
        graphItemMissing: true,
      },
    });

    expect(state.isV2StateActive).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.mutationLedger).toEqual([]);
    expect(state.mutationRecoveryQuarantine).toEqual([
      expect.objectContaining({
        operationId: mutation.intent.operationId,
        record: expect.objectContaining({
          intent: expect.objectContaining({
            operationId: mutation.intent.operationId,
          }),
          receipt: expect.objectContaining({
            operationId: mutation.intent.operationId,
          }),
        }),
      }),
    ]);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.isV2StateActive).toBe(true);
    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.mutationRecoveryQuarantine).toEqual(
      state.mutationRecoveryQuarantine,
    );
  });

  it("leaves the active receipt blocking when V2 quarantine persistence fails", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    await state.beginMutationIntent(mutation.intent);
    await state.recordMutationReceipt(mutation.receipt);
    harness.plugin.updatePluginData = vi.fn().mockRejectedValueOnce(
      new Error("plugin data write failed"),
    );

    await expect(state.quarantineUnreachableUploadReceipt({
      record: {
        intent: mutation.intent,
        receipt: mutation.receipt,
      },
      remoteId: mutation.remote.driveId,
      localMissing: true,
      graphItemMissing: true,
    })).rejects.toThrow("plugin data write failed");

    expect(state.isV2StateActive).toBe(true);
    expect(state.mutationLedger).toEqual([{
      intent: mutation.intent,
      receipt: mutation.receipt,
    }]);
    expect(state.mutationRecoveryQuarantine).toEqual([]);
  });

  it("fails closed when a persisted V2 recovery quarantine is malformed", async () => {
    const harness = makeHarness({
      pluginData: {
        "easy-sync-v2-recovery-quarantine": [{
          version: 2,
          kind: "mutation-recovery-quarantine",
          operationId: "truncated-record",
        }],
      },
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.isV2StateActive).toBe(true);
    expect(state.hasMutationRecoveryQuarantineCorruption).toBe(true);
    expect(state.mutationRecoveryQuarantine).toEqual([]);
  });

  it("commits a durable mutation receipt to V2 before clearing the ledger", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const { intent, receipt, remote } = uploadMutation();

    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);
    await state.commitMutationCheckpoint(intent.operationId);

    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(remote);
    expect(state.baseSnapshot).toContainEqual(receipt.checkpoint.baseUpserts[0]);
    expect(harness.readCommitted().meta.commitSeq).toBe(4);
  });

  it("keeps the original blocker across restart and atomically checkpoints its reviewed continuation", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    await state.beginMutationIntent(mutation.intent);
    const expectedRecord = structuredClone(state.mutationLedger[0]);
    const manualIntent: MutationIntentV1 = {
      ...mutation.intent,
      operationId: "manual-upload-new",
      createdAt: 30,
    };
    const resolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-local",
      factsDigest: "c".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      intent: manualIntent,
      receipt: null,
    };

    await expect(state.attachManualMutationResolution(expectedRecord, resolution))
      .resolves.toBe(true);
    expect(state.mutationLedger[0]).toMatchObject({
      intent: mutation.intent,
      receipt: null,
      manualResolution: resolution,
    });
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger[0]).toMatchObject({
      intent: mutation.intent,
      receipt: null,
      manualResolution: resolution,
    });

    const receipt: MutationReceiptV1 = {
      ...mutation.receipt,
      operationId: manualIntent.operationId,
    };
    await restarted.recordManualMutationResolutionReceipt(
      mutation.intent.operationId,
      receipt,
    );
    await restarted.commitManualMutationResolutionCheckpoint(
      mutation.intent.operationId,
    );

    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.remoteSnapshot).toContainEqual(mutation.remote);
    expect(restarted.baseSnapshot).toContainEqual(
      mutation.receipt.checkpoint.baseUpserts[0],
    );
    expect(restarted.manualMutationResolutionAudit).toEqual([
      expect.objectContaining({
        sourceOperationId: mutation.intent.operationId,
        resolutionOperationId: manualIntent.operationId,
        choice: "keep-local",
        action: "upload",
        externalMutation: true,
      }),
    ]);
  });

  it("rejects a persisted manual choice whose action contradicts that choice", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    await state.beginMutationIntent(mutation.intent);
    const contradictory: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-remote",
      factsDigest: "e".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      intent: {
        ...mutation.intent,
        operationId: "manual-contradictory-upload",
        createdAt: 30,
      },
      receipt: null,
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      contradictory,
    )).rejects.toThrow("evidence is invalid");
    expect(state.mutationLedger).toEqual([{
      intent: mutation.intent,
      receipt: null,
    }]);
  });

  it("retries reviewed checkpoint cleanup after the V2 commit survives a plugin-data failure", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    await state.beginMutationIntent(mutation.intent);
    const manualIntent: MutationIntentV1 = {
      ...mutation.intent,
      operationId: "manual-crash-window",
      createdAt: 30,
    };
    const manualReceipt: MutationReceiptV1 = {
      ...mutation.receipt,
      operationId: manualIntent.operationId,
    };
    await state.attachManualMutationResolution(state.mutationLedger[0], {
      version: 1,
      choice: "keep-local",
      factsDigest: "d".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      intent: manualIntent,
      receipt: manualReceipt,
    });
    harness.plugin.updatePluginData = vi.fn().mockRejectedValueOnce(
      new Error("crash after V2 commit"),
    );

    await expect(state.commitManualMutationResolutionCheckpoint(
      mutation.intent.operationId,
    )).rejects.toThrow("crash after V2 commit");
    expect(harness.readCommitted().remoteIndex.itemsById[mutation.remote.driveId])
      .toBeDefined();
    expect(state.mutationLedger).toHaveLength(1);

    harness.plugin.updatePluginData = vi.fn(async (mutator) => mutator(harness.pluginData));
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    await expect(restarted.commitManualMutationResolutionCheckpoint(
      mutation.intent.operationId,
    )).resolves.toBeUndefined();
    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.manualMutationResolutionAudit).toHaveLength(1);
  });

  it("drops malformed local audit history and bounds valid history to the latest twenty records", async () => {
    const valid = Array.from({ length: 23 }, (_, index) => ({
      version: 1,
      sourceOperationId: `source-${index}`,
      resolutionOperationId: `resolution-${index}`,
      path: `note-${index}.md`,
      choice: "keep-local",
      action: "upload",
      externalMutation: true,
      selectedAt: index,
      completedAt: index + 1,
    }));
    const boundedHarness = makeHarness({
      pluginData: {
        "easy-sync-v2-manual-mutation-resolution-audit": valid,
      },
    });
    const bounded = new StateManager(boundedHarness.plugin);
    await bounded.load();
    expect(bounded.manualMutationResolutionAudit).toHaveLength(20);
    expect(bounded.manualMutationResolutionAudit[0].sourceOperationId).toBe("source-3");

    const malformedHarness = makeHarness({
      pluginData: {
        "easy-sync-v2-manual-mutation-resolution-audit": [{ version: 1 }],
      },
    });
    const malformed = new StateManager(malformedHarness.plugin);
    await malformed.load();
    expect(malformed.manualMutationResolutionAudit).toEqual([]);
  });

  it("keeps JSON authority when IndexedDB selection hits quota", async () => {
    const quotaError = new DOMException(
      "storage quota exhausted during initialization",
      "QuotaExceededError",
    );
    let deleteCandidate: ReturnType<typeof vi.spyOn> | null = null;
    let closeCandidate: ReturnType<typeof vi.spyOn> | null = null;
    const harness = makeHarness({
      indexedDbFactory: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(
          databaseId,
          recovery,
        );
        deleteCandidate = vi.spyOn(store, "delete");
        closeCandidate = vi.spyOn(store, "close");
        vi.spyOn(store, "initialize").mockRejectedValueOnce(quotaError);
        return store;
      },
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    const witness = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    expect(witness.storageAuthority).toBeUndefined();
    expect(state.isV2StateActive).toBe(true);
    expect(state.getCommittedV2Envelope()).toEqual(envelope());
    expect(harness.readCommitted()).toEqual(envelope());
    expect(deleteCandidate).not.toHaveBeenCalled();
    expect(closeCandidate).toHaveBeenCalledOnce();
    await state.close();
  });

  it("keeps JSON authority when the Vault-local IndexedDB identity is unavailable", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    delete harness.plugin.indexedDbVaultInstanceId;
    const state = new StateManager(harness.plugin);

    await state.load();

    const witness = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    expect(witness.storageAuthority).toBeUndefined();
    expect(state.isV2StateActive).toBe(true);
    expect(state.getCommittedV2Envelope()).toEqual(envelope());
    expect(harness.readCommitted()).toEqual(envelope());
    await state.close();
  });

  it("keeps a receipt and the previous state when an active commit hits quota", async () => {
    let activeStore: StateV2IndexedDbActiveStore | null = null;
    const harness = makeHarness({
      indexedDbFactory: (databaseId, recovery) => {
        activeStore = new StateV2IndexedDbActiveStore(
          databaseId,
          recovery,
        );
        return activeStore;
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      const selectedWitnessRaw =
        harness.files.get(paths.stateV2AuthorityWitnessFile)!;
      databaseId = JSON.parse(
        selectedWitnessRaw,
      ).storageAuthority.databaseId;
      const { intent, receipt, remote } = uploadMutation();
      await state.beginMutationIntent(intent);
      await state.recordMutationReceipt(receipt);
      if (!activeStore) throw new Error("active store was not created");
      vi.spyOn(activeStore, "commit").mockRejectedValueOnce(
        new DOMException(
          "storage quota exhausted during commit",
          "QuotaExceededError",
        ),
      );

      await expect(
        state.commitMutationCheckpoint(intent.operationId),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });

      expect(state.mutationLedger).toEqual([{ intent, receipt }]);
      expect(state.getCommittedV2Envelope()).toEqual(envelope());
      expect(await activeStore.inspect()).toMatchObject({
        phase: "ready",
        commitSeq: 3,
        counts: {
          remoteNodes: 2,
          anchors: 1,
          folderAnchors: 1,
        },
      });
      expect(harness.readCommitted()).toEqual(envelope());
      expect(
        harness.files.get(paths.stateV2AuthorityWitnessFile),
      ).toBe(selectedWitnessRaw);

      await state.commitMutationCheckpoint(intent.operationId);
      expect(state.mutationLedger).toEqual([]);
      expect(state.getCommittedV2Envelope()?.meta.commitSeq).toBe(4);
      expect(state.remoteSnapshot).toContainEqual(remote);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("selects IndexedDB and recovers it on a host without native structuredClone", async () => {
    vi.stubGlobal("structuredClone", undefined);
    await import("../src/structured-clone-compat");
    expect(typeof globalThis.structuredClone).toBe("function");
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let restarted: StateManager | null = null;
    let replacementDatabaseId: string | null = null;
    try {
      await state.load();
      const selectedWitness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      const selectedDatabaseId =
        selectedWitness.storageAuthority.databaseId as string;
      expect(selectedWitness).toMatchObject({
        revision: 2,
        storageAuthority: {
          kind: "indexeddb",
          databaseId: selectedDatabaseId,
          stateCommitSeq: 3,
        },
      });

      const { intent, receipt, remote } = uploadMutation();
      await state.beginMutationIntent(intent);
      await state.recordMutationReceipt(receipt);
      await state.commitMutationCheckpoint(intent.operationId);

      expect(state.getCommittedV2Envelope()?.meta.commitSeq).toBe(4);
      expect(state.remoteSnapshot).toContainEqual(remote);
      expect(harness.readCommitted().meta.commitSeq).toBe(3);

      await state.close();
      await deleteDB(
        stateV2ActiveIndexedDbDatabaseName(selectedDatabaseId),
      );
      restarted = new StateManager(harness.plugin);
      await restarted.load();

      const replacementWitness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      replacementDatabaseId =
        replacementWitness.storageAuthority.databaseId as string;
      expect(replacementDatabaseId).not.toBe(selectedDatabaseId);
      expect(replacementWitness).toMatchObject({
        revision: 3,
        storageAuthority: {
          kind: "indexeddb",
          stateCommitSeq: 4,
        },
      });
      expect(restarted.v2StateLoadRecoveryBlock).toBeNull();
      expect(restarted.getCommittedV2Envelope()?.meta.commitSeq).toBe(4);
      expect(restarted.remoteSnapshot).toContainEqual(remote);
      expect(harness.readCommitted().meta.commitSeq).toBe(3);
    } finally {
      await (restarted ?? state).close();
      if (replacementDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(replacementDatabaseId),
        );
      }
      vi.unstubAllGlobals();
    }
  });

  it("rebinds a cloned active Vault without opening or deleting the source Vault database", async () => {
    const sourceHarness = makeHarness({
      indexedDbActive: true,
      indexedDbVaultInstanceId: "1".repeat(32),
    });
    const sourceState = new StateManager(sourceHarness.plugin);
    let sourceReload: StateManager | null = null;
    let cloneState: StateManager | null = null;
    let cloneReload: StateManager | null = null;
    let sourceDatabaseId = "";
    let cloneDatabaseId = "";
    const cloneConstructedDatabaseIds: string[] = [];
    try {
      await sourceState.load();
      const sourceWitness = JSON.parse(
        sourceHarness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      sourceDatabaseId = sourceWitness.storageAuthority.databaseId;
      expect(sourceWitness.storageAuthority).toMatchObject({
        schemaVersion: 2,
        vaultInstanceId: "1".repeat(32),
      });
      await sourceState.close();

      const cloneHarness = makeHarness({
        indexedDbVaultInstanceId: "2".repeat(32),
        indexedDbFactory: (databaseId, recovery) => {
          cloneConstructedDatabaseIds.push(databaseId);
          return new StateV2IndexedDbActiveStore(databaseId, recovery);
        },
      });
      cloneHarness.files.clear();
      cloneHarness.folders.clear();
      for (const [path, value] of sourceHarness.files) {
        cloneHarness.files.set(path, value);
      }
      for (const path of sourceHarness.folders) {
        cloneHarness.folders.add(path);
      }
      for (const key of Object.keys(cloneHarness.pluginData)) {
        delete cloneHarness.pluginData[key];
      }
      Object.assign(
        cloneHarness.pluginData,
        structuredClone(sourceHarness.pluginData),
      );

      cloneState = new StateManager(cloneHarness.plugin);
      await cloneState.load();
      const cloneWitness = JSON.parse(
        cloneHarness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      cloneDatabaseId = cloneWitness.storageAuthority.databaseId;
      expect(cloneWitness).toMatchObject({
        revision: sourceWitness.revision + 1,
        storageAuthority: {
          schemaVersion: 2,
          vaultInstanceId: "2".repeat(32),
          stateCommitSeq: 3,
        },
      });
      expect(cloneDatabaseId).not.toBe(sourceDatabaseId);
      expect(cloneConstructedDatabaseIds).not.toContain(sourceDatabaseId);
      expect(cloneConstructedDatabaseIds).toEqual([cloneDatabaseId]);
      expect(cloneState.v2StateLoadRecoveryBlock).toBeNull();
      await cloneState.close();

      sourceReload = new StateManager(sourceHarness.plugin);
      await sourceReload.load();
      expect(sourceReload.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: sourceDatabaseId,
        stateCommitSeq: 3,
      });
      const { intent, receipt } = uploadMutation();
      await sourceReload.beginMutationIntent(intent);
      await sourceReload.recordMutationReceipt(receipt);
      await sourceReload.commitMutationCheckpoint(intent.operationId);
      expect(sourceReload.getCommittedV2Envelope()?.meta.commitSeq).toBe(4);
      await sourceReload.close();

      cloneReload = new StateManager(cloneHarness.plugin);
      await cloneReload.load();
      expect(cloneReload.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: cloneDatabaseId,
        stateCommitSeq: 3,
      });
      expect(cloneReload.getCommittedV2Envelope()?.meta.commitSeq).toBe(3);
    } finally {
      await (cloneReload ?? cloneState)?.close();
      await (sourceReload ?? sourceState).close();
      if (sourceDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(sourceDatabaseId),
        );
      }
      if (cloneDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(cloneDatabaseId),
        );
      }
    }
  });

  it("upgrades a legacy unscoped binding without deleting its possibly shared database", async () => {
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbVaultInstanceId: "3".repeat(32),
    });
    const state = new StateManager(harness.plugin);
    let restarted: StateManager | null = null;
    let legacyDatabaseId = "";
    let reboundDatabaseId = "";
    try {
      await state.load();
      const witness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      legacyDatabaseId = witness.storageAuthority.databaseId;
      const legacyStorage = { ...witness.storageAuthority };
      delete legacyStorage.vaultInstanceId;
      legacyStorage.schemaVersion = 1;
      harness.files.set(
        paths.stateV2AuthorityWitnessFile,
        JSON.stringify({ ...witness, storageAuthority: legacyStorage }),
      );
      await state.close();

      restarted = new StateManager(harness.plugin);
      await restarted.load();
      const reboundWitness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      reboundDatabaseId = reboundWitness.storageAuthority.databaseId;
      expect(reboundWitness).toMatchObject({
        revision: witness.revision + 1,
        storageAuthority: {
          schemaVersion: 2,
          vaultInstanceId: "3".repeat(32),
          stateCommitSeq: 3,
        },
      });
      expect(reboundDatabaseId).not.toBe(legacyDatabaseId);

      const legacyDb = await openDB(
        stateV2ActiveIndexedDbDatabaseName(legacyDatabaseId),
        1,
      );
      expect(await legacyDb.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId: legacyDatabaseId,
      });
      legacyDb.close();
    } finally {
      await (restarted ?? state).close();
      if (legacyDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(legacyDatabaseId),
        );
      }
      if (reboundDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(reboundDatabaseId),
        );
      }
    }
  });

  it("keeps a cloned witness and source database intact when namespace rebind initialization fails", async () => {
    const sourceHarness = makeHarness({
      indexedDbActive: true,
      indexedDbVaultInstanceId: "4".repeat(32),
    });
    const sourceState = new StateManager(sourceHarness.plugin);
    let sourceDatabaseId = "";
    let attemptedReplacementId = "";
    try {
      await sourceState.load();
      sourceDatabaseId = JSON.parse(
        sourceHarness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ).storageAuthority.databaseId;
      await sourceState.close();

      const cloneHarness = makeHarness({
        indexedDbVaultInstanceId: "5".repeat(32),
        indexedDbFactory: (databaseId, recovery) => {
          attemptedReplacementId = databaseId;
          const store = new StateV2IndexedDbActiveStore(
            databaseId,
            recovery,
          );
          vi.spyOn(store, "initialize").mockRejectedValueOnce(
            new DOMException("clone rebind quota exhausted", "QuotaExceededError"),
          );
          return store;
        },
      });
      cloneHarness.files.clear();
      cloneHarness.folders.clear();
      for (const [path, value] of sourceHarness.files) {
        cloneHarness.files.set(path, value);
      }
      for (const path of sourceHarness.folders) {
        cloneHarness.folders.add(path);
      }
      const copiedWitness = cloneHarness.files.get(
        paths.stateV2AuthorityWitnessFile,
      )!;

      const blocked = new StateManager(cloneHarness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(attemptedReplacementId).not.toBe("");
      expect(attemptedReplacementId).not.toBe(sourceDatabaseId);
      expect(cloneHarness.files.get(paths.stateV2AuthorityWitnessFile))
        .toBe(copiedWitness);
      await blocked.close();

      const sourceDb = await openDB(
        stateV2ActiveIndexedDbDatabaseName(sourceDatabaseId),
        1,
      );
      expect(await sourceDb.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId: sourceDatabaseId,
      });
      sourceDb.close();
    } finally {
      await sourceState.close();
      if (sourceDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(sourceDatabaseId),
        );
      }
      if (attemptedReplacementId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(attemptedReplacementId),
        );
      }
    }
  });

  it("keeps JSON authority when the Vault-local identity changes during initial preparation", async () => {
    let currentVaultInstanceId = "6".repeat(32);
    let preparedDatabaseId = "";
    const harness = makeHarness({
      indexedDbVaultInstanceId: currentVaultInstanceId,
      readIndexedDbVaultInstanceId: () => currentVaultInstanceId,
      indexedDbFactory: (databaseId, recovery) => {
        preparedDatabaseId = databaseId;
        const store = new StateV2IndexedDbActiveStore(
          databaseId,
          recovery,
        );
        const initialize = store.initialize.bind(store);
        vi.spyOn(store, "initialize").mockImplementation(async (...args) => {
          const result = await initialize(...args);
          currentVaultInstanceId = "7".repeat(32);
          return result;
        });
        return store;
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "json",
        databaseId: null,
      });
      expect(state.isV2StateActive).toBe(true);
      expect(JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      )).not.toHaveProperty("storageAuthority");
      const preparedDb = await openDB(
        stateV2ActiveIndexedDbDatabaseName(preparedDatabaseId),
        1,
      );
      expect(await preparedDb.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId: preparedDatabaseId,
      });
      preparedDb.close();
    } finally {
      await state.close();
      if (preparedDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(preparedDatabaseId),
        );
      }
    }
  });

  it("fails closed without deleting a candidate selected by another instance during initialization", async () => {
    const vaultInstanceId = "c".repeat(32);
    let candidateDatabaseId = "";
    let harness: ReturnType<typeof makeHarness>;
    harness = makeHarness({
      indexedDbVaultInstanceId: vaultInstanceId,
      readIndexedDbVaultInstanceId: () => vaultInstanceId,
      indexedDbFactory: (databaseId, recovery) => {
        candidateDatabaseId = databaseId;
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        const initialize = store.initialize.bind(store);
        vi.spyOn(store, "initialize").mockImplementation(async (...args) => {
          await initialize(...args);
          const inspection = await store.inspect();
          const current = JSON.parse(
            harness.files.get(paths.stateV2AuthorityWitnessFile)!,
          );
          harness.files.set(
            paths.stateV2AuthorityWitnessFile,
            JSON.stringify({
              ...current,
              revision: current.revision + 1,
              updatedAt: Math.max(Date.now(), current.updatedAt),
              storageAuthority: {
                schemaVersion: 2,
                kind: "indexeddb",
                vaultInstanceId,
                databaseId,
                stateCommitSeq: envelope().meta.commitSeq,
                lifecycleEpoch: envelope().meta.lifecycleEpoch,
                stateDigest: inspection.stateDigest,
                selectedAt: Date.now(),
              },
            }),
          );
          throw new Error("another instance selected the prepared database");
        });
        return store;
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-load-failed",
      });
      expect(state.activeV2StorageAuthorityEvidence).toBeNull();
      expect(state.isV2StateActive).toBe(false);
      const selectedDb = await openDB(
        stateV2ActiveIndexedDbDatabaseName(candidateDatabaseId),
        1,
      );
      expect(await selectedDb.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId: candidateDatabaseId,
      });
      selectedDb.close();
    } finally {
      await state.close();
      if (candidateDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(candidateDatabaseId),
        );
      }
    }
  });

  it("keeps a retryable candidate when witness CAS fails before selection", async () => {
    let candidateDatabaseId = "";
    let deleteCandidate: ReturnType<typeof vi.spyOn> | null = null;
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbFactory: (databaseId, recovery) => {
        candidateDatabaseId = databaseId;
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        deleteCandidate = vi.spyOn(store, "delete");
        return store;
      },
    });
    harness.rawAdapter.process.mockImplementationOnce(async (
      path: string,
    ) => {
      expect(path).toBe(paths.stateV2AuthorityWitnessFile);
      harness.files.delete(paths.stateV2AuthorityWitnessNextFile);
      throw new Error("authority CAS stopped before commit");
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "json",
        databaseId: null,
      });
      expect(deleteCandidate).not.toHaveBeenCalled();
      const preparedDb = await openDB(
        stateV2ActiveIndexedDbDatabaseName(candidateDatabaseId),
        1,
      );
      expect(await preparedDb.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId: candidateDatabaseId,
      });
      preparedDb.close();
    } finally {
      await state.close();
      if (candidateDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(candidateDatabaseId),
        );
      }
    }
  });

  it("keeps the selected store live when authority CAS commits but its response is lost", async () => {
    let candidateDatabaseId = "";
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbFactory: (databaseId, recovery) => {
        candidateDatabaseId = databaseId;
        return new StateV2IndexedDbActiveStore(databaseId, recovery);
      },
    });
    harness.rawAdapter.process.mockImplementationOnce(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      expect(path).toBe(paths.stateV2AuthorityWitnessFile);
      const current = harness.files.get(path);
      if (current === undefined) throw new Error(`missing ${path}`);
      const selected = fn(current);
      harness.files.set(path, selected);
      throw new Error("authority CAS response was lost after commit");
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: candidateDatabaseId,
      });
      const { intent, receipt, remote } = uploadMutation();
      await state.beginMutationIntent(intent);
      await state.recordMutationReceipt(receipt);
      await state.commitMutationCheckpoint(intent.operationId);
      expect(state.mutationLedger).toEqual([]);
      expect(state.remoteSnapshot).toContainEqual(remote);
    } finally {
      await state.close();
      if (candidateDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(candidateDatabaseId),
        );
      }
    }
  });

  it("fails closed if the Vault-local identity changes after the authority CAS", async () => {
    let currentVaultInstanceId = "a".repeat(32);
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbVaultInstanceId: currentVaultInstanceId,
      readIndexedDbVaultInstanceId: () => currentVaultInstanceId,
    });
    harness.rawAdapter.process.mockImplementationOnce(async (
      path: string,
      fn: (value: string) => string,
    ) => {
      const value = harness.files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      const next = fn(value);
      harness.files.set(path, next);
      currentVaultInstanceId = "b".repeat(32);
      return next;
    });
    const state = new StateManager(harness.plugin);
    let selectedDatabaseId = "";
    try {
      await state.load();
      const witness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      selectedDatabaseId = witness.storageAuthority.databaseId;

      expect(witness.storageAuthority).toMatchObject({
        schemaVersion: 2,
        vaultInstanceId: "a".repeat(32),
      });
      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-load-failed",
      });
      expect(state.activeV2StorageAuthorityEvidence).toBeNull();
      expect(state.isV2StateActive).toBe(false);
    } finally {
      await state.close();
      if (selectedDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(selectedDatabaseId),
        );
      }
    }
  });

  it("fails closed before opening a selected database when the captured Vault identity was overwritten", async () => {
    let currentVaultInstanceId = "8".repeat(32);
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbVaultInstanceId: currentVaultInstanceId,
      readIndexedDbVaultInstanceId: () => currentVaultInstanceId,
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ).storageAuthority.databaseId;
      await state.close();

      currentVaultInstanceId = "9".repeat(32);
      const factory = vi.fn(
        harness.plugin.createStateV2IndexedDbActiveStore!,
      );
      harness.plugin.createStateV2IndexedDbActiveStore = factory;
      const blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(factory).not.toHaveBeenCalled();
      await blocked.close();
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("fails closed before opening a selected database when the local Vault identity is unavailable", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ).storageAuthority.databaseId;
      await state.close();

      const factory = vi.fn(
        harness.plugin.createStateV2IndexedDbActiveStore!,
      );
      harness.plugin.createStateV2IndexedDbActiveStore = factory;
      delete harness.plugin.indexedDbVaultInstanceId;
      const blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(factory).not.toHaveBeenCalled();
      await blocked.close();

      const db = await openDB(
        stateV2ActiveIndexedDbDatabaseName(databaseId),
        1,
      );
      expect(await db.get("meta", "state")).toMatchObject({
        phase: "ready",
        databaseId,
      });
      db.close();
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("blocks a corrupt selected IndexedDB instead of falling back to stale JSON", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    let restarted: StateManager | null = null;
    try {
      await state.load();
      const witness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      databaseId = witness.storageAuthority.databaseId;
      await state.close();

      const db = await openDB(
        stateV2ActiveIndexedDbDatabaseName(databaseId),
        1,
      );
      const changed = {
        ...envelope().remoteIndex.itemsById["file-a"]!,
        eTag: "tampered",
      };
      await db.put("remoteNodes", changed, "file-a");
      db.close();

      restarted = new StateManager(harness.plugin);
      await restarted.load();

      expect(restarted.isV2StateActive).toBe(false);
      expect(restarted.legacyAutoSyncAllowed).toBe(false);
      expect(restarted.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(harness.readCommitted().meta.commitSeq).toBe(3);
    } finally {
      await (restarted ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("keeps the old binding when a lost database cannot be rebuilt within quota", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let blocked: StateManager | null = null;
    let selectedDatabaseId = "";
    let replacementDatabaseId = "";
    try {
      await state.load();
      const selectedWitnessRaw =
        harness.files.get(paths.stateV2AuthorityWitnessFile)!;
      selectedDatabaseId = JSON.parse(
        selectedWitnessRaw,
      ).storageAuthority.databaseId;
      await state.close();
      await deleteDB(
        stateV2ActiveIndexedDbDatabaseName(selectedDatabaseId),
      );

      harness.plugin.createStateV2IndexedDbActiveStore = (
        databaseId,
        recovery,
      ) => {
        const store = new StateV2IndexedDbActiveStore(
          databaseId,
          recovery,
        );
        if (databaseId !== selectedDatabaseId) {
          replacementDatabaseId = databaseId;
          vi.spyOn(store, "initialize").mockRejectedValueOnce(
            new DOMException(
              "storage quota exhausted during recovery",
              "QuotaExceededError",
            ),
          );
        }
        return store;
      };
      blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(replacementDatabaseId).not.toBe("");
      expect(replacementDatabaseId).not.toBe(selectedDatabaseId);
      expect(
        harness.files.get(paths.stateV2AuthorityWitnessFile),
      ).toBe(selectedWitnessRaw);
      expect(harness.readCommitted()).toEqual(envelope());
    } finally {
      await (blocked ?? state).close();
      if (selectedDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(selectedDatabaseId),
        );
      }
      if (replacementDatabaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(replacementDatabaseId),
        );
      }
    }
  });

  it("does not misclassify a lost IndexedDB connection as database loss", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let blocked: StateManager | null = null;
    let recovered: StateManager | null = null;
    let databaseId = "";
    try {
      await state.load();
      const selectedWitnessRaw =
        harness.files.get(paths.stateV2AuthorityWitnessFile)!;
      databaseId = JSON.parse(
        selectedWitnessRaw,
      ).storageAuthority.databaseId;
      await state.close();

      harness.plugin.createStateV2IndexedDbActiveStore = (
        selectedDatabaseId,
        recovery,
      ) => {
        const store = new StateV2IndexedDbActiveStore(
          selectedDatabaseId,
          recovery,
        );
        vi.spyOn(store, "load").mockRejectedValueOnce(
          new DOMException(
            "Connection to Indexed Database server lost",
            "UnknownError",
          ),
        );
        return store;
      };
      blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      expect(
        harness.files.get(paths.stateV2AuthorityWitnessFile),
      ).toBe(selectedWitnessRaw);
      expect(harness.readCommitted()).toEqual(envelope());

      harness.plugin.createStateV2IndexedDbActiveStore = (
        selectedDatabaseId,
        recovery,
      ) => new StateV2IndexedDbActiveStore(
        selectedDatabaseId,
        recovery,
      );
      recovered = new StateManager(harness.plugin);
      await recovered.load();

      expect(recovered.v2StateLoadRecoveryBlock).toBeNull();
      expect(recovered.getCommittedV2Envelope()).toEqual(envelope());
      expect(JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ).storageAuthority.databaseId).toBe(databaseId);
    } finally {
      await (recovered ?? blocked ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("reconciles a database commit whose recovery witness was interrupted", async () => {
    const harness = makeHarness({ indexedDbActive: true });
    const state = new StateManager(harness.plugin);
    let restarted: StateManager | null = null;
    let databaseId = "";
    try {
      await state.load();
      const { intent, receipt, remote } = uploadMutation();
      await state.beginMutationIntent(intent);
      await state.recordMutationReceipt(receipt);
      harness.failNextIndexedDbWitness();

      await expect(
        state.commitMutationCheckpoint(intent.operationId),
      ).rejects.toThrow("indexeddb witness write failed");
      expect(state.mutationLedger).toEqual([{ intent, receipt }]);
      expect(state.getCommittedV2Envelope()?.meta.commitSeq).toBe(3);
      expect(harness.readCommitted().meta.commitSeq).toBe(3);

      await state.close();
      restarted = new StateManager(harness.plugin);
      await restarted.load();
      expect(restarted.getCommittedV2Envelope()?.meta.commitSeq).toBe(4);
      expect(restarted.mutationLedger).toEqual([{ intent, receipt }]);

      await restarted.commitMutationCheckpoint(intent.operationId);
      expect(restarted.mutationLedger).toEqual([]);
      expect(restarted.remoteSnapshot).toContainEqual(remote);
      const witness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      );
      databaseId = witness.storageAuthority.databaseId;
    } finally {
      await (restarted ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("keeps a receipt on publication failure and replays it after restart", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const { intent, receipt, remote } = uploadMutation();
    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);
    harness.failNextStateRename();

    await expect(state.commitMutationCheckpoint(intent.operationId))
      .rejects.toThrow("state rename failed");
    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(true);
    expect(harness.readCommitted().meta.commitSeq).toBe(3);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger).toEqual([{ intent, receipt }]);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    await restarted.commitMutationCheckpoint(intent.operationId);

    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.remoteSnapshot).toContainEqual(remote);
    expect(restarted.baseSnapshot).toContainEqual(receipt.checkpoint.baseUpserts[0]);
    expect(harness.readCommitted().meta.commitSeq).toBe(4);
  });

  it("reloads and commits a receipted folder create through the V2 envelope", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const createdFolder: RemoteFolderEntry = {
      path: "Notes/New",
      driveId: "folder-new",
      parentId: folder.driveId,
      name: "New",
      eTag: "etag-folder-new",
    };
    const intent: FolderMutationIntentV2 = {
      version: 2,
      operationId: "create-folder-new",
      planRevision: 2,
      scope,
      action: "createRemoteFolder",
      path: createdFolder.path,
      expectedLocal: { exists: true },
      expectedRemote: { exists: false },
      expectedParent: {
        driveId: folder.driveId,
        path: folder.path,
      },
      createdAt: 50,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 60,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
        folderUpserts: [createdFolder],
      },
    };

    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);
    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.mutationLedger).toEqual([{ intent, receipt }]);
    await restarted.commitMutationCheckpoint(intent.operationId);

    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.remoteFolders).toContainEqual(createdFolder);
    expect(harness.readCommitted()).toMatchObject({
      meta: { commitSeq: 4 },
      folderAnchors: {
        byAnchorId: {
          "folder:folder-new": {
            remoteId: createdFolder.driveId,
            lastPath: createdFolder.path,
            parentRemoteId: createdFolder.parentId,
            remoteETag: createdFolder.eTag,
            confirmedGeneration: 4,
          },
        },
      },
    });
  });

  it("keeps V2 authority blocked when the manifest points beyond the committed envelope", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2ManifestFile, JSON.stringify(manifest(4)));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.isV2StateActive).toBe(false);
    expect(state.isV2AuthoritySelected).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "manifest-envelope-behind",
    });
    expect(state.remoteScope).toBeNull();
    expect(state.remoteSnapshot).toEqual([]);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("backfills durable V2 authority memory and blocks V1 after the manifest is later deleted", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();

    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      schemaVersion: 1,
      kind: "state-v2-authority-witness",
      status: "active",
      manifest: manifest(),
    });

    harness.files.delete(paths.stateV2ManifestFile);
    harness.rawAdapter.read.mockClear();
    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-manifest-missing",
    });
    expect(restarted.isV2AuthoritySelected).toBe(true);
    expect(restarted.isV2StateActive).toBe(false);
    expect(restarted.legacyAutoSyncAllowed).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("blocks both authorities when a witness cannot be interpreted without a manifest", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2ManifestFile);
    harness.files.set(paths.stateV2AuthorityWitnessFile, "{");
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "unknown",
      reason: "authority-witness-unreadable",
    });
    expect(state.isV2AuthoritySelected).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("keeps V2 authority when the persisted witness no longer matches its manifest", async () => {
    const harness = makeHarness();
    const initial = new StateManager(harness.plugin);
    await initial.load();
    harness.files.set(paths.stateV2ManifestFile, JSON.stringify({
      ...manifest(),
      migratedAt: 2,
    }));
    const restarted = new StateManager(harness.plugin);

    await restarted.load();

    expect(restarted.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-mismatch",
    });
    expect(restarted.isV2StateActive).toBe(false);
    expect(restarted.legacyAutoSyncAllowed).toBe(false);
  });

  it("blocks both state owners when witness presence itself cannot be read", async () => {
    const harness = makeHarness();
    harness.rawAdapter.exists.mockImplementation(async (path: string) => {
      if (
        path === paths.stateV2AuthorityWitnessFile
        || path === paths.stateV2AuthorityWitnessNextFile
      ) {
        throw new Error("adapter stat failed");
      }
      return harness.files.has(path);
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-presence-unreadable",
    });
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(false);
  });

  it("blocks legacy downgrade artifacts instead of exposing V1", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2ManifestFile);
    harness.files.set(
      paths.stateV2RetiredManifestFile,
      JSON.stringify(manifest()),
    );
    harness.files.set(paths.stateV2RollbackFile, JSON.stringify({
      schemaVersion: 1,
      sourceCommitSeq: 3,
      scope,
    }));
    harness.rawAdapter.read.mockClear();

    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "unknown",
      reason: "legacy-v2-downgrade-artifacts-present",
    });
    expect(restarted.legacyAutoSyncAllowed).toBe(false);
    expect(restarted.remoteScope).toBeNull();
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("keeps manifest-selected V2 read-only when authority memory cannot be persisted", async () => {
    const harness = makeHarness();
    harness.rawAdapter.write.mockImplementation(
      async (path: string, value: string) => {
        if (path === paths.stateV2AuthorityWitnessNextFile) {
          throw new Error("witness storage unavailable");
        }
        harness.files.set(path, value);
      },
    );
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-save-failed",
      detail: "Error: witness storage unavailable",
    });
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(false);
  });

  it.each([
    ["{", "manifest-unreadable"],
    [JSON.stringify({ schemaVersion: 99 }), "manifest-unsupported"],
  ] as const)(
    "keeps V2 authority when its committed manifest cannot load (%s)",
    async (rawManifest, reason) => {
      const harness = makeHarness();
      harness.files.set(paths.stateV2ManifestFile, rawManifest);
      const state = new StateManager(harness.plugin);

      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason,
      });
      expect(state.isV2AuthoritySelected).toBe(true);
      expect(state.isV2StateActive).toBe(false);
      expect(state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
        paths.remoteStateFile,
      );
    },
  );

  it("blocks both authorities when manifest presence itself cannot be read", async () => {
    const harness = makeHarness();
    harness.rawAdapter.exists.mockImplementation(async (path: string) => {
      if (path === paths.stateV2ManifestFile) {
        throw new Error("adapter stat failed");
      }
      return harness.files.has(path);
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "unknown",
      reason: "manifest-presence-unreadable",
    });
    expect(state.isV2AuthoritySelected).toBe(false);
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it.each([
    ["{", "envelope-unreadable"],
    [JSON.stringify({ meta: { schemaVersion: 99 } }), "envelope-unsupported"],
  ] as const)(
    "keeps V2 authority when its committed envelope cannot load (%s)",
    async (rawEnvelope, reason) => {
      const harness = makeHarness();
      harness.files.set(paths.stateV2File, rawEnvelope);
      const state = new StateManager(harness.plugin);

      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason,
      });
      expect(state.isV2AuthoritySelected).toBe(true);
      expect(state.isV2StateActive).toBe(false);
      expect(state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
        paths.remoteStateFile,
      );
    },
  );

  it("activates the journal-proven next envelope when only the retired previous slot is corrupt", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2PreviousFile, "{broken");
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 1,
      status: "publishing",
      scope,
      previousCommitSeq: 2,
      nextCommitSeq: 3,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(state.baseSnapshot).toEqual([{
      path: remoteA.path,
      hash: hashA,
      size: remoteA.size,
      eTag: remoteA.eTag,
    }]);
    expect(harness.files.has(paths.stateV2PreviousFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("activates the journal-bound previous envelope after a corrupt replacement candidate", async () => {
    const previous = envelope(3);
    const corruptCommitted = envelope(4);
    corruptCommitted.remoteIndex.itemsById[remoteA.driveId]!.parentId =
      "missing-parent";
    const harness = makeHarness({ committed: corruptCommitted });
    harness.files.set(paths.stateV2PreviousFile, JSON.stringify(previous));
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 1,
      status: "publishing",
      scope,
      previousCommitSeq: 3,
      nextCommitSeq: 4,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(JSON.parse(harness.files.get(paths.stateV2File)!)).toEqual(previous);
    expect(harness.files.has(paths.stateV2PreviousFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("activates a journal-bound staged envelope after the old slot became unreadable", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2File);
    harness.files.set(paths.stateV2PreviousFile, "{broken");
    harness.files.set(paths.stateV2NextFile, JSON.stringify(envelope(3)));
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 1,
      status: "publishing",
      scope,
      previousCommitSeq: 2,
      nextCommitSeq: 3,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(JSON.parse(harness.files.get(paths.stateV2File)!))
      .toEqual(envelope(3));
    expect(harness.files.has(paths.stateV2NextFile)).toBe(false);
    expect(harness.files.has(paths.stateV2PreviousFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("repairs invalid cursor metadata before activating the manifest-selected envelope", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.cursorRevision = -1;
    corrupt.remoteIndex.deltaLink = "stale-delta";
    const harness = makeHarness({ committed: corrupt });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(state.remoteDeltaLink).toBeNull();
    expect(JSON.parse(harness.files.get(paths.stateV2File)!)).toMatchObject({
      meta: {
        lifecycleEpoch: 2,
        commitSeq: 4,
      },
      remoteIndex: {
        cursorRevision: 0,
        deltaLink: null,
        itemsById: envelope(3).remoteIndex.itemsById,
      },
      anchors: envelope(3).anchors,
    });
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("resumes cursor repair through StateManager when only its journal was durable", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.cursorRevision = -1;
    const harness = makeHarness({ committed: corrupt });
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 2,
      status: "repairing-cursor",
      scope,
      previousCommitSeq: 3,
      nextCommitSeq: 4,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(state.remoteDeltaLink).toBeNull();
    expect(JSON.parse(harness.files.get(paths.stateV2File)!)).toMatchObject({
      meta: { commitSeq: 4 },
      remoteIndex: { cursorRevision: 0, deltaLink: null },
      anchors: corrupt.anchors,
      folderAnchors: corrupt.folderAnchors,
    });
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("activates a staged cursor repair after the corrupt committed slot was moved", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.cursorRevision = -1;
    const candidate = structuredClone(corrupt);
    candidate.meta.commitSeq = 4;
    candidate.meta.committedAt = 10;
    candidate.remoteIndex.cursorRevision = 0;
    candidate.remoteIndex.deltaLink = null;
    const harness = makeHarness();
    harness.files.delete(paths.stateV2File);
    harness.files.set(paths.stateV2PreviousFile, JSON.stringify(corrupt));
    harness.files.set(paths.stateV2NextFile, JSON.stringify(candidate));
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 2,
      status: "repairing-cursor",
      scope,
      previousCommitSeq: 3,
      nextCommitSeq: 4,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(state.remoteDeltaLink).toBeNull();
    expect(JSON.parse(harness.files.get(paths.stateV2File)!)).toEqual(candidate);
    expect(harness.files.has(paths.stateV2PreviousFile)).toBe(false);
    expect(harness.files.has(paths.stateV2NextFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("does not hide anchor corruption behind cursor repair", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.cursorRevision = -1;
    corrupt.anchors.byAnchorId["file:file-a"]!.anchorId = "wrong-anchor";
    const harness = makeHarness({ committed: corrupt });
    const raw = harness.files.get(paths.stateV2File);
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "envelope-remote-index-and-anchors-corrupt",
    });
    expect(state.v2CorruptStateRecoveryEvidence).toMatchObject({
      version: 1,
      kind: "v2-corrupt-state-evidence",
      scope,
      sourceCommitSeq: 3,
      sourceLifecycleEpoch: 2,
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      corruption: "remote-index-and-anchors",
    });
    expect(state.v2CorruptStateRecoveryEvidence)
      .not.toHaveProperty("rawEnvelope");
    expect(state.isV2StateActive).toBe(false);
    expect(harness.files.get(paths.stateV2File)).toBe(raw);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("classifies a stable remote-index corruption without changing its bytes", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.itemsById[remoteA.driveId]!.parentId =
      "missing-parent";
    const harness = makeHarness({ committed: corrupt });
    const raw = harness.files.get(paths.stateV2File);
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "envelope-remote-index-corrupt",
    });
    expect(state.v2CorruptStateRecoveryEvidence).toMatchObject({
      scope,
      sourceCommitSeq: 3,
      corruption: "remote-index",
    });
    expect(harness.files.get(paths.stateV2File)).toBe(raw);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("classifies mixed identity and anchor corruption without guessing recovery", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.itemsById[remoteA.driveId]!.parentId =
      "missing-parent";
    corrupt.anchors.byAnchorId["file:file-a"]!.anchorId =
      "wrong-anchor";
    const harness = makeHarness({ committed: corrupt });
    const raw = harness.files.get(paths.stateV2File);
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "envelope-remote-index-and-anchors-corrupt",
    });
    expect(state.v2CorruptStateRecoveryEvidence).toMatchObject({
      scope,
      sourceCommitSeq: 3,
      corruption: "remote-index-and-anchors",
    });
    expect(state.isV2StateActive).toBe(false);
    expect(harness.files.get(paths.stateV2File)).toBe(raw);
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
  });

  it("publishes an exact content-addressed forensic copy before corrupt-state recovery", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.itemsById[remoteA.driveId]!.parentId =
      "missing-parent";
    const harness = makeHarness({ committed: corrupt });
    const raw = harness.files.get(paths.stateV2File)!;
    const state = new StateManager(harness.plugin);
    await state.load();
    const digest = state.v2CorruptStateRecoveryEvidence!.sourceDigest;

    const source = await state.prepareV2CorruptStateRecoverySource();

    expect(source.rawEnvelope).toBe(raw);
    expect(harness.files.get(
      `${paths.stateV2CorruptSourcePrefix}${digest}.json`,
    )).toBe(raw);
    expect(harness.files.has(
      `${paths.stateV2CorruptSourcePrefix}${digest}.json.next`,
    )).toBe(false);
    expect(harness.files.get(paths.stateV2File)).toBe(raw);
  });

  it("accepts forensic staged-write and final-rename response loss only after exact read-back", async () => {
    for (const loss of ["write", "rename"] as const) {
      const corrupt = envelope(3);
      corrupt.remoteIndex.itemsById[remoteA.driveId]!.parentId =
        "missing-parent";
      const harness = makeHarness({ committed: corrupt });
      const state = new StateManager(harness.plugin);
      await state.load();
      const digest = state.v2CorruptStateRecoveryEvidence!.sourceDigest;
      const committed =
        `${paths.stateV2CorruptSourcePrefix}${digest}.json`;
      if (loss === "write") {
        harness.rawAdapter.write.mockImplementationOnce(
          async (path: string, value: string) => {
            harness.files.set(path, value);
            throw new Error("forensic write response lost");
          },
        );
      } else {
        harness.rawAdapter.rename.mockImplementationOnce(
          async (from: string, to: string) => {
            const value = harness.files.get(from);
            if (value === undefined) throw new Error(`missing ${from}`);
            harness.files.delete(from);
            harness.files.set(to, value);
            throw new Error("forensic rename response lost");
          },
        );
      }

      await expect(state.prepareV2CorruptStateRecoverySource())
        .resolves.toMatchObject({ sourceDigest: digest });
      expect(harness.files.get(committed))
        .toBe(harness.files.get(paths.stateV2File));
    }
  });

  it("refuses to overwrite conflicting corrupt-state forensic evidence", async () => {
    const corrupt = envelope(3);
    corrupt.remoteIndex.itemsById[remoteA.driveId]!.parentId =
      "missing-parent";
    const harness = makeHarness({ committed: corrupt });
    const raw = harness.files.get(paths.stateV2File)!;
    const state = new StateManager(harness.plugin);
    await state.load();
    const digest = state.v2CorruptStateRecoveryEvidence!.sourceDigest;
    harness.files.set(
      `${paths.stateV2CorruptSourcePrefix}${digest}.json`,
      "different",
    );

    await expect(state.prepareV2CorruptStateRecoverySource())
      .rejects.toThrow("different bytes");
    expect(harness.files.get(paths.stateV2File)).toBe(raw);
  });

  it("reloads only a source-matching corrupt-state review hold", async () => {
    const corrupt = envelope(3);
    corrupt.anchors.byAnchorId["file:file-a"]!.anchorId = "wrong-anchor";
    const harness = makeHarness({ committed: corrupt });
    const first = new StateManager(harness.plugin);
    await first.load();
    const evidence = first.v2CorruptStateRecoveryEvidence!;
    const candidate = envelope(4);
    candidate.meta.lifecycleEpoch = 3;
    const items: SyncPlanItem[] = [];
    const canonicalIdentity = {
      version: 2 as const,
      scope,
      sourceCommitSeq: 4,
      digest: canonicalPlanDigestV2({
        items,
        lastTotalFiles: 1,
        scope,
        sourceCommitSeq: 4,
      }),
    };
    harness.files.set(paths.stateV2CorruptRecoveryFile, JSON.stringify({
      schemaVersion: 1,
      kind: "v2-corrupt-state-recovery-hold",
      revision: 1,
      phase: "pending",
      createdAt: 1,
      updatedAt: 1,
      sourceDigest: evidence.sourceDigest,
      sourceCommitSeq: evidence.sourceCommitSeq,
      sourceLifecycleEpoch: evidence.sourceLifecycleEpoch,
      corruption: evidence.corruption,
      scope,
      candidate,
      canonicalIdentity,
      canonicalReview: {
        counts: {
          uploads: 0,
          downloads: 0,
          folders: 0,
          deletes: 0,
          conflicts: 0,
          skipped: 0,
        },
        impactCount: 0,
      },
      lastTotalFiles: 1,
      items,
    }));

    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.activeV2CorruptStateRecoveryHold).toMatchObject({
      phase: "pending",
      sourceDigest: evidence.sourceDigest,
    });
    expect(restarted.v2StateLoadRecoveryBlock?.reason)
      .toBe("envelope-anchors-corrupt");
  });

  it.each([
    [
      "publication journal promotion",
      paths.stateV2CorruptPublicationNextFile,
      paths.stateV2CorruptPublicationFile,
    ],
    [
      "candidate envelope promotion",
      paths.stateV2NextFile,
      paths.stateV2File,
    ],
    [
      "manifest promotion",
      paths.stateV2ManifestNextFile,
      paths.stateV2ManifestFile,
    ],
    [
      "authority witness promotion",
      paths.stateV2AuthorityWitnessNextFile,
      paths.stateV2AuthorityWitnessFile,
    ],
  ])(
    "resumes a journaled corrupt-state authority publication after interrupted %s on StateManager restart",
    async (_boundary, interruptedFrom, interruptedTo) => {
    const corrupt = envelope(3);
    corrupt.anchors.byAnchorId["file:file-a"]!.anchorId = "wrong-anchor";
    const harness = makeHarness({ committed: corrupt });
    const sourceManifest = manifest();
    harness.files.set(
      paths.stateV2AuthorityWitnessFile,
      JSON.stringify({
        schemaVersion: 1,
        kind: "state-v2-authority-witness",
        revision: 1,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        manifest: sourceManifest,
      }),
    );
    const state = new StateManager(harness.plugin);
    await state.load();
    const source = await state.prepareV2CorruptStateRecoverySource();
    const candidate = envelope(4);
    candidate.meta.lifecycleEpoch = source.sourceLifecycleEpoch + 1;
    const items: SyncPlanItem[] = [];
    const canonicalIdentity = {
      version: 2 as const,
      scope,
      sourceCommitSeq: candidate.meta.commitSeq,
      digest: canonicalPlanDigestV2({
        items,
        lastTotalFiles: 1,
        scope,
        sourceCommitSeq: candidate.meta.commitSeq,
      }),
    };
    await state.stageV2CorruptStateRecoveryHold({
      source,
      candidate,
      canonicalIdentity,
      canonicalReview: summarizeCanonicalPlanReviewV2(items),
      lastTotalFiles: 1,
      items,
    });
    await state.setPlanReviewBundle(
      items,
      summarizeCanonicalPlanReviewV2(items).counts,
      scope,
      canonicalIdentity,
    );
    const authorization = state.planReviewAuthorization!;
    await expect(state.confirmV2CorruptStateRecoveryHold(authorization))
      .resolves.toMatchObject({ phase: "confirmed" });

    const authorityProcess =
      interruptedFrom === paths.stateV2AuthorityWitnessNextFile;
    const baseRename = harness.rawAdapter.rename.getMockImplementation()!;
    let interruptPromotion = true;
    if (authorityProcess) {
      const baseProcess =
        harness.rawAdapter.process.getMockImplementation()!;
      harness.rawAdapter.process.mockImplementation(
        async (path: string, fn: (value: string) => string) => {
          if (
            interruptPromotion
            && path === paths.stateV2AuthorityWitnessFile
          ) {
            interruptPromotion = false;
            throw new Error("authority promotion interrupted");
          }
          return baseProcess(path, fn);
        },
      );
    } else {
      harness.rawAdapter.rename.mockImplementation(
        async (from: string, to: string) => {
          if (
            interruptPromotion
            && from === interruptedFrom
            && to === interruptedTo
          ) {
            interruptPromotion = false;
            throw new Error("authority promotion interrupted");
          }
          return baseRename(from, to);
        },
      );
    }

    await expect(
      state.publishConfirmedV2CorruptStateRecovery(authorization, 50),
    ).rejects.toThrow("authority promotion interrupted");
    expect(
      harness.files.has(paths.stateV2CorruptPublicationFile)
      || harness.files.has(paths.stateV2CorruptPublicationNextFile),
    ).toBe(true);
    expect(harness.files.has(interruptedTo)).toBe(authorityProcess);
    expect(harness.files.has(interruptedFrom)).toBe(true);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.isV2StateActive).toBe(true);
    expect(restarted.hasV2StateLoadRecoveryBlock).toBe(false);
    expect(restarted.activeV2CorruptStateRecoveryHold).toBeNull();
    expect(restarted.planReviewActive).toBe(true);
    expect(restarted.getCommittedV2Envelope()).toEqual(candidate);
    expect(JSON.parse(harness.files.get(paths.stateV2ManifestFile)!))
      .toMatchObject({
        stateCommitSeq: candidate.meta.commitSeq,
        lifecycleEpoch: candidate.meta.lifecycleEpoch,
        scope,
      });
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      revision: 2,
      manifest: {
        stateCommitSeq: candidate.meta.commitSeq,
        lifecycleEpoch: candidate.meta.lifecycleEpoch,
        scope,
      },
    });
    expect(harness.files.has(paths.stateV2CorruptPublicationFile)).toBe(false);
    expect(harness.files.has(paths.stateV2CorruptPublicationNextFile))
      .toBe(false);
    expect(harness.files.get(
      `${paths.stateV2CorruptSourcePrefix}${source.sourceDigest}.json`,
    )).toBe(JSON.stringify(corrupt));
    expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
      paths.remoteStateFile,
    );
    },
  );

  it.each([
    ["unreadable", "{"],
    ["mismatch", null],
  ] as const)(
    "blocks a %s corrupt-state recovery hold before Graph",
    async (kind, raw) => {
      const corrupt = envelope(3);
      corrupt.anchors.byAnchorId["file:file-a"]!.anchorId =
        "wrong-anchor";
      const harness = makeHarness({ committed: corrupt });
      if (raw) {
        harness.files.set(paths.stateV2CorruptRecoveryFile, raw);
      } else {
        const first = new StateManager(harness.plugin);
        await first.load();
        const evidence = first.v2CorruptStateRecoveryEvidence!;
        const candidate = envelope(4);
        candidate.meta.lifecycleEpoch = 3;
        const items: SyncPlanItem[] = [];
        harness.files.set(
          paths.stateV2CorruptRecoveryFile,
          JSON.stringify({
            schemaVersion: 1,
            kind: "v2-corrupt-state-recovery-hold",
            revision: 1,
            phase: "pending",
            createdAt: 1,
            updatedAt: 1,
            sourceDigest: "f".repeat(64),
            sourceCommitSeq: evidence.sourceCommitSeq,
            sourceLifecycleEpoch: evidence.sourceLifecycleEpoch,
            corruption: evidence.corruption,
            scope,
            candidate,
            canonicalIdentity: {
              version: 2,
              scope,
              sourceCommitSeq: 4,
              digest: canonicalPlanDigestV2({
                items,
                lastTotalFiles: 1,
                scope,
                sourceCommitSeq: 4,
              }),
            },
            canonicalReview: {
              counts: {
                uploads: 0,
                downloads: 0,
                folders: 0,
                deletes: 0,
                conflicts: 0,
                skipped: 0,
              },
              impactCount: 0,
            },
            lastTotalFiles: 1,
            items,
          }),
        );
      }
      const state = new StateManager(harness.plugin);
      await state.load();

      expect(state.v2StateLoadRecoveryBlock?.reason).toBe(
        kind === "unreadable"
          ? "corrupt-state-recovery-hold-unreadable"
          : "corrupt-state-recovery-hold-mismatch",
      );
      expect(state.isV2StateActive).toBe(false);
      expect(harness.rawAdapter.read).not.toHaveBeenCalledWith(
        paths.remoteStateFile,
      );
    },
  );

  it("keeps an ambiguous publication journal for a later V2-only recovery", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 1,
      status: "publishing",
      scope,
      previousCommitSeq: 1,
      nextCommitSeq: 2,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "publication-state-ambiguous",
    });
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(true);
    expect(state.isV2AuthoritySelected).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
  });

  it.each([
    ["{", "publication-journal-unreadable"],
    [JSON.stringify({ version: 99 }), "publication-journal-unsupported"],
  ] as const)(
    "keeps an unreadable publication journal under V2 authority (%s)",
    async (rawJournal, reason) => {
      const harness = makeHarness();
      harness.files.set(paths.stateV2RecoveryFile, rawJournal);
      const state = new StateManager(harness.plugin);

      await state.load();

      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason,
      });
      expect(harness.files.get(paths.stateV2RecoveryFile)).toBe(rawJournal);
      expect(state.isV2AuthoritySelected).toBe(true);
      expect(state.legacyAutoSyncAllowed).toBe(false);
    },
  );

  it("keeps V2 authority when its manifest has no recoverable envelope", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2File);
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "manifest-envelope-missing",
    });
    expect(state.isV2AuthoritySelected).toBe(true);
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(false);
  });

  it("keeps a loaded V2 envelope read-only when its migration hold is unreadable", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2MigrationHoldFile, "{");
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "migration-hold-unreadable",
    });
    expect(state.isV2StateActive).toBe(true);
    expect(state.isV2AuthoritySelected).toBe(true);
    expect(state.legacyAutoSyncAllowed).toBe(false);
    await expect(state.clearRemoteState()).rejects.toThrow(
      "V2 load recovery",
    );
  });

  it("auto-recovers a publication that durably reached the next V2 envelope", async () => {
    const harness = makeHarness();
    harness.files.set(paths.stateV2PreviousFile, JSON.stringify(envelope(2)));
    harness.files.set(paths.stateV2RecoveryFile, JSON.stringify({
      version: 1,
      status: "publishing",
      scope,
      previousCommitSeq: 2,
      nextCommitSeq: 3,
      startedAt: 10,
    }));
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2StateActive).toBe(true);
    expect(state.isV2AuthoritySelected).toBe(true);
    expect(harness.files.has(paths.stateV2PreviousFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
  });

  it("does not treat an unpublished envelope as V2 authority without a manifest", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2ManifestFile);
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2AuthoritySelected).toBe(false);
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(true);
    expect(state.remoteScope).toMatchObject({
      driveId: "stale-drive",
    });
  });

  it("ignores an orphaned active IndexedDB without a manifest or authority witness", async () => {
    const activeFactory = vi.fn((databaseId, recovery) =>
      new StateV2IndexedDbActiveStore(databaseId, recovery));
    const harness = makeHarness({
      indexedDbVaultInstanceId: "e".repeat(32),
      indexedDbFactory: activeFactory,
    });
    harness.files.delete(paths.stateV2ManifestFile);
    harness.files.delete(paths.stateV2File);
    harness.files.delete(paths.stateV2AuthorityWitnessFile);
    const orphanDatabaseId = "f".repeat(32);
    const orphan = new StateV2IndexedDbActiveStore(
      orphanDatabaseId,
      {
        publishCheckpoint: vi.fn(async () => undefined),
      } as never,
    );
    const state = new StateManager(harness.plugin);
    try {
      await orphan.initialize(envelope());
      await orphan.close();

      await state.load();

      expect(activeFactory).not.toHaveBeenCalled();
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.isV2AuthoritySelected).toBe(false);
      expect(state.isV2StateActive).toBe(false);
      expect(state.legacyAutoSyncAllowed).toBe(true);
      expect(state.remoteScope).toMatchObject({ driveId: "stale-drive" });
      expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
      await expect(orphan.load()).resolves.toEqual(envelope());
    } finally {
      await state.close();
      await orphan.delete();
    }
  });

  it("cleans an invalid staged-only corrupt publication without selecting V2 authority", async () => {
    const harness = makeHarness();
    harness.files.delete(paths.stateV2ManifestFile);
    harness.files.set(paths.stateV2CorruptPublicationNextFile, "{");
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(harness.files.has(paths.stateV2CorruptPublicationNextFile))
      .toBe(false);
    expect(state.v2StateLoadRecoveryBlock).toBeNull();
    expect(state.isV2AuthoritySelected).toBe(false);
    expect(state.isV2StateActive).toBe(false);
    expect(state.legacyAutoSyncAllowed).toBe(true);
    expect(state.remoteScope).toMatchObject({
      driveId: "stale-drive",
    });
  });
});
