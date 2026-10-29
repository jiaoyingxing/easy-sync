// V2 权威、作用域与基线事实
// 由 tests/state-manager-v2.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  paths,
  scope,
  hashA,
  hashB,
  folder,
  remoteA,
  envelope,
  makeHarness,
  uploadMutation,
  uploadMutationAt,
} from "./helpers/state-manager-v2-harness";
import { deleteDB } from "idb";
import { sha256Hex } from "../src/crypto";
import { StateManager } from "../src/sync/state-manager";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type {
  BaseFileEntry,
  MutationLedgerEntryV1,
  RemoteFileEntry,
} from "../src/sync/types";
import { stateV2ActiveIndexedDbDatabaseName } from "../src/sync/state-v2-indexeddb-active";

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

  it("exposes committed baseline facts for one path without writing anything", async () => {
    const harness = makeHarness({ committed: envelope() });
    const state = new StateManager(harness.plugin);
    await state.load();
    const writesBefore = harness.rawAdapter.write.mock.calls.length;

    expect(state.baselineFactsForPath(remoteA.path)).toEqual({
      hash: hashA,
      size: remoteA.size,
      at: 1,
    });
    expect(state.baselineFactsForPath("Notes/missing.md")).toBeUndefined();
    expect(state.remoteETagForPath(remoteA.path)).toBe(remoteA.eTag);
    expect(state.remoteETagForPath("Notes/missing.md")).toBeUndefined();

    expect(harness.rawAdapter.write.mock.calls.length).toBe(writesBefore);
    expect(harness.readCommitted().anchors.byAnchorId["file:file-a"])
      .toMatchObject({
        lastPath: remoteA.path,
        contentHash: hashA,
        size: remoteA.size,
        confirmedAt: 1,
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

  it("publishes one ancestor-manifest refresh for one eight-entry base batch", async () => {
    const committed = envelope();
    const entries: BaseFileEntry[] = [];
    const contentByPath = new Map<string, string>();
    for (let index = 0; index < 8; index++) {
      const path = `Notes/batch-${index}.md`;
      const content = `batch ${index}\n`;
      const bytes = new TextEncoder().encode(content);
      const hash = await sha256Hex(bytes);
      const driveId = `file-batch-${index}`;
      const eTag = `etag-batch-${index}`;
      committed.remoteIndex.itemsById[driveId] = {
        id: driveId,
        parentId: folder.driveId,
        name: `batch-${index}.md`,
        kind: "file",
        size: bytes.byteLength,
        mtime: index,
        eTag,
        cTag: `ctag-batch-${index}`,
        contentHash: hash,
      };
      committed.anchors.byAnchorId[`file:${driveId}`] = {
        anchorId: `file:${driveId}`,
        remoteId: driveId,
        lastPath: path,
        contentHash: hash,
        size: bytes.byteLength,
        remoteETag: eTag,
        confirmedAt: 1,
        confirmedBy: "equal-read",
      };
      entries.push({
        path,
        hash,
        size: bytes.byteLength,
        eTag,
      });
      contentByPath.set(path, content);
    }
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();
    for (const entry of entries) {
      state.cacheBaseContent(entry.path, contentByPath.get(entry.path)!);
    }
    harness.rawAdapter.list.mockClear();

    const ancestorHashes = await state.upsertBaseEntries(entries);

    expect(Object.keys(ancestorHashes)).toHaveLength(entries.length);
    // Old implementation rebuilt the whole manifest once per file (8 lists of
    // the object directory); one checkpoint batch now rebuilds it once.
    expect(harness.rawAdapter.list.mock.calls.filter(
      ([path]) => path === paths.ancestorsV2Dir,
    )).toHaveLength(1);
    expect(JSON.parse(
      harness.files.get(paths.ancestorManifestV2File)!,
    ).textHashes).toEqual(Object.values(ancestorHashes).sort());
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

  it("advances the content-fact sequence only when the published content changes", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const initialFactSeq =
      state.activeV2StorageAuthorityEvidence?.contentFactCommitSeq;
    const initialCommitSeq =
      state.activeV2StorageAuthorityEvidence?.stateCommitSeq;
    expect(initialFactSeq).toBe(initialCommitSeq);

    // A rotated delta cursor publishes a new envelope (raw sequence advances)
    // but the content is identical, so the fact sequence must not move.
    await state.setRemoteState([remoteA], "delta-cursor-only", scope, [folder]);
    const afterCursorOnly = state.activeV2StorageAuthorityEvidence;
    expect(afterCursorOnly?.stateCommitSeq).toBeGreaterThan(
      initialCommitSeq as number,
    );
    expect(afterCursorOnly?.contentFactCommitSeq).toBe(initialFactSeq);

    // A real remote fact change advances both sequences.
    await state.setRemoteState(
      [{ ...remoteA, eTag: "etag-a-fact-change" }],
      "delta-fact-change",
      scope,
      [folder],
    );
    const afterContent = state.activeV2StorageAuthorityEvidence;
    expect(afterContent?.contentFactCommitSeq).toBeGreaterThan(
      initialFactSeq as number,
    );
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

  it.each([
    {
      name: "different-path intent-only records",
      records: (() => {
        const first = uploadMutation();
        const second = uploadMutationAt(1);
        second.intent.operationId = first.intent.operationId;
        return [
          { intent: first.intent, receipt: null },
          { intent: second.intent, receipt: null },
        ];
      })(),
    },
    {
      name: "byte-identical receipted records",
      records: (() => {
        const mutation = uploadMutation();
        const record = { intent: mutation.intent, receipt: mutation.receipt };
        return [record, structuredClone(record)];
      })(),
    },
  ])("fails closed on persisted duplicate operation IDs in $name without rewriting evidence", async ({ records }) => {
    const pendingConflicts = [{ path: records[0].intent.path }];
    const pendingDeletes = [{ path: records[1].intent.path }];
    const pluginData = {
      "easy-sync-bound-account": scope.accountId,
      "easy-sync-v2-mutation-ledger": records,
      "easy-sync-pending-conflicts": pendingConflicts,
      "easy-sync-pending-remote-deletes": pendingDeletes,
    };
    const before = JSON.stringify(pluginData);
    const harness = makeHarness({ pluginData });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.hasMutationLedgerCorruption).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(JSON.stringify(harness.pluginData)).toBe(before);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"])
      .toEqual(records);
    expect(harness.pluginData["easy-sync-pending-conflicts"])
      .toEqual(pendingConflicts);
    expect(harness.pluginData["easy-sync-pending-remote-deletes"])
      .toEqual(pendingDeletes);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
  });

  it.each([
    "abandon",
    "record-receipt",
    "checkpoint",
    "reflected-retirement",
    "quarantine",
  ] as const)("keeps exact evidence when the %s owner encounters a duplicate operation ID", async (owner) => {
    const mutation = uploadMutation();
    mutation.receipt.checkpoint.pendingDeleteRemovals = [];
    const record: MutationLedgerEntryV1 = {
      intent: mutation.intent,
      receipt: owner === "abandon" || owner === "record-receipt"
        ? null
        : mutation.receipt,
    };
    const harness = makeHarness({
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [record],
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    (state.mutationLedger as MutationLedgerEntryV1[])
      .push(structuredClone(record));
    vi.mocked(harness.plugin.updatePluginData).mockClear();
    const ledgerBefore = structuredClone(state.mutationLedger);
    const envelopeBefore = structuredClone(state.getCommittedV2Envelope());

    const action = owner === "abandon"
      ? state.abandonMutationIntent(record.intent.operationId)
      : owner === "record-receipt"
        ? state.recordMutationReceipt(mutation.receipt)
        : owner === "checkpoint"
          ? state.commitMutationCheckpoint(record.intent.operationId)
          : owner === "reflected-retirement"
            ? state.retireMutationCheckpointIfReflected(
                record.intent.operationId,
                state.getCommittedV2Envelope()!.meta.commitSeq,
              )
            : state.quarantineUnreachableUploadReceipt({
                record,
                remoteId: mutation.remote.driveId,
                localMissing: true,
                graphItemMissing: true,
              });

    await expect(action).rejects.toThrow(/duplicate mutation operation/i);
    expect(state.mutationLedger).toEqual(ledgerBefore);
    expect(state.getCommittedV2Envelope()).toEqual(envelopeBefore);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
  });

  it("refuses to abandon a parser-readable ordinary intent with invalid action expectations", async () => {
    const mutation = uploadMutation();
    const malformed: MutationLedgerEntryV1 = {
      intent: {
        ...mutation.intent,
        operationId: "invalid-direct-abandon",
        action: "deleteLocal",
        expectedLocal: { exists: false },
        expectedRemote: { exists: false },
      },
      receipt: null,
    };
    const harness = makeHarness({
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [malformed],
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    vi.mocked(harness.plugin.updatePluginData).mockClear();
    const before = structuredClone(state.getCommittedV2Envelope());

    await expect(state.abandonMutationIntent(malformed.intent.operationId))
      .rejects.toThrow(/abandon evidence is invalid/i);

    expect(state.mutationLedger).toEqual([malformed]);
    expect(state.getCommittedV2Envelope()).toEqual(before);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
  });

  it.each([
    { name: "restore old bytes", expectedExists: true },
    { name: "remove a newly downloaded target", expectedExists: false },
  ])("keeps full reset read-only when a local journal would $name", async ({ expectedExists }) => {
    const targetPath = expectedExists
      ? "Notes/journal-restore.md"
      : "Notes/journal-remove.md";
    const oldBytes = "old user bytes";
    const downloadedBytes = "interrupted download";
    const oldBuffer = new TextEncoder().encode(oldBytes).buffer;
    const downloadedBuffer = new TextEncoder().encode(downloadedBytes).buffer;
    const recoveryPath = `${paths.tmpDir}/recovery/original.bin`;
    const journalPath = `${paths.tmpDir}/recovery/intent.json`;
    const journal = JSON.stringify({
      version: 1,
      targetPath,
      recoveryPath,
      recoveryMode: "copy",
      expected: expectedExists
        ? { hash: await sha256Hex(oldBuffer), size: oldBuffer.byteLength }
        : null,
      downloaded: {
        hash: await sha256Hex(downloadedBuffer),
        size: downloadedBuffer.byteLength,
      },
      createdAt: 1,
    });
    const harness = makeHarness({
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-history": [{ id: "must-stay" }],
      },
    });
    harness.files.set(targetPath, downloadedBytes);
    harness.files.set(journalPath, journal);
    if (expectedExists) harness.files.set(recoveryPath, oldBytes);
    const state = new StateManager(harness.plugin);
    await state.load();
    const pluginDataBefore = JSON.stringify(harness.pluginData);
    const manifestBefore = harness.files.get(paths.stateV2ManifestFile);
    const stateBefore = harness.files.get(paths.stateV2File);

    await expect(state.reset()).rejects.toThrow(/local file recovery/i);

    expect(harness.files.get(targetPath)).toBe(downloadedBytes);
    expect(harness.files.get(journalPath)).toBe(journal);
    expect(harness.files.get(recoveryPath))
      .toBe(expectedExists ? oldBytes : undefined);
    expect(JSON.stringify(harness.pluginData)).toBe(pluginDataBefore);
    expect(harness.files.get(paths.stateV2ManifestFile)).toBe(manifestBefore);
    expect(harness.files.get(paths.stateV2File)).toBe(stateBefore);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
  });
});
