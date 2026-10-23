// 重置、检查点退役与胶囊恢复
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
  manifest,
  makeHarness,
} from "./helpers/state-manager-v2-harness";
import { deleteDB } from "idb";
import { sha256Hex } from "../src/crypto";
import { StateManager } from "../src/sync/state-manager";
import type {
  MutationLedgerEntryV1,
  RemoteFileEntry,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";
import {
  IndexedDbRemoteScopeRecoveryEvidenceStore,
} from "../src/sync/remote-scope-recovery-evidence-store";
import {
  StateV2IndexedDbActiveStore,
  stateV2ActiveIndexedDbDatabaseName,
} from "../src/sync/state-v2-indexeddb-active";
import { MergeReadyStore } from "../src/sync/merge-ready-store";

describe("StateManager V2 production controller", () => {
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

  it("finishes reset when a regenerable directory is locked, cleans the rest, and records the leftover", async () => {
    const harness = makeHarness({
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "sync-interval": 15,
        "easy-sync-diagnostic-log": true,
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      harness.folders.add(paths.ancestorsV2Dir);
      harness.folders.add(paths.stateV2IndexedDbRecoveryDir);
      harness.files.set(`${paths.ancestorsV2Dir}/${hashA}.txt`, "ancestor");
      harness.files.set(
        `${paths.stateV2IndexedDbRecoveryDir}/checkpoint-000000000001.json`,
        "{}",
      );

      // OneDrive-style lock: the client holds handles inside its sync root,
      // so one directory cannot be removed this attempt (EPERM, errno -4048).
      const lockedDirectory = paths.ancestorsV2Dir;
      const originalRmdir = harness.rawAdapter.rmdir.getMockImplementation();
      harness.rawAdapter.rmdir.mockImplementation(
        async (path: string, recursive: boolean) => {
          if (path === lockedDirectory) {
            throw Object.assign(
              new Error(`EPERM: operation not permitted, rmdir '${path}'`),
              { code: "EPERM", errno: -4048, syscall: "rmdir", path },
            );
          }
          return originalRmdir!(path, recursive);
        },
      );

      // The reset must finish: manifest and database are already gone by the
      // time directory cleanup runs, so aborting cannot preserve anything.
      await expect(state.reset()).resolves.toBeUndefined();

      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();

      // The recovery journal (the one directory that can permanently block a
      // fresh activation with stale future records) must be gone even though
      // the locked directory survived.
      expect(harness.folders.has(paths.stateV2IndexedDbRecoveryDir))
        .toBe(false);
      expect(harness.folders.has(lockedDirectory)).toBe(true);

      // The leftover is disclosed with the exact path for manual removal.
      expect(state.lastResetLeftoverDirectories).toEqual([lockedDirectory]);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("orphans an engine-unreadable IndexedDB database by rotating the Vault instance identity and still completes reset", async () => {
    const deleteAttempts: string[] = [];
    let corruptedDatabaseId: string | null = null;
    const harness = makeHarness({
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "sync-interval": 15,
      },
      diag: { warn: vi.fn() },
      rotateIndexedDbVaultInstanceId: () => "2".repeat(32),
      indexedDbFactory: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        const originalDelete = store.delete.bind(store);
        return Object.assign(store, {
          delete: async (): Promise<void> => {
            deleteAttempts.push(databaseId);
            if (databaseId === corruptedDatabaseId) {
              throw new Error("UnknownError: Internal error.");
            }
            await originalDelete();
          },
        });
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      corruptedDatabaseId =
        state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      expect(corruptedDatabaseId).not.toBe("");

      await expect(state.reset()).resolves.toBeUndefined();

      // The Vault instance identity rotated in storage and in the plugin's
      // captured binding, so the identity stays usable after the reset.
      expect(harness.plugin.indexedDbVaultInstanceId).toBe("2".repeat(32));
      expect(harness.plugin.readIndexedDbVaultInstanceId?.())
        .toBe("2".repeat(32));

      // The unreadable database was attempted exactly once and then orphaned
      // in place: never deleted again, never selected again.
      expect(deleteAttempts).toEqual([corruptedDatabaseId]);
      expect((await indexedDB.databases()).map((entry) => entry.name))
        .toContain(stateV2ActiveIndexedDbDatabaseName(corruptedDatabaseId));

      // The remaining cleanup still finished: witness and manifest artifacts
      // are gone, the reload after reset lands fresh and the plugin data is
      // zeroed.
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
      expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(state.boundAccountId).toBe("");
      expect(state.remoteGeneration).toBe(0);

      // The rotation left a diagnostic account with old and new ids.
      expect(harness.plugin.diag?.warn).toHaveBeenCalledWith(
        "state",
        expect.stringContaining("rotating the Vault instance identity"),
        expect.objectContaining({
          trigger: "v2-active-state-delete",
          previousInstanceId: "1".repeat(32),
          newInstanceInstanceId: "2".repeat(32),
        }),
      );
    } finally {
      await state.close();
      for (const id of [corruptedDatabaseId, "2".repeat(32)]) {
        if (id) {
          await deleteDB(stateV2ActiveIndexedDbDatabaseName(id)).catch(
            () => undefined,
          );
        }
      }
    }
  });

  it("does not rotate the Vault instance identity when reset succeeds on a healthy IndexedDB store", async () => {
    const deleteAttempts: string[] = [];
    const harness = makeHarness({
      indexedDbActive: true,
      diag: { warn: vi.fn() },
      rotateIndexedDbVaultInstanceId: () => "2".repeat(32),
      indexedDbFactory: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        const originalDelete = store.delete.bind(store);
        return Object.assign(store, {
          delete: async (): Promise<void> => {
            deleteAttempts.push(databaseId);
            await originalDelete();
          },
        });
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      expect(databaseId).not.toBe("");

      await expect(state.reset()).resolves.toBeUndefined();

      // A healthy database is deleted normally: no rotation, no orphan, no
      // rotation diagnostic.
      expect(harness.plugin.indexedDbVaultInstanceId).toBe("1".repeat(32));
      expect(harness.plugin.readIndexedDbVaultInstanceId?.())
        .toBe("1".repeat(32));
      expect(deleteAttempts).toEqual([databaseId]);
      expect((await indexedDB.databases()).map((entry) => entry.name))
        .not.toContain(stateV2ActiveIndexedDbDatabaseName(databaseId));
      expect(harness.plugin.diag?.warn).not.toHaveBeenCalled();
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId)).catch(
          () => undefined,
        );
      }
    }
  });

  it("keeps reset usable on the rotated identity after an orphaning rescue", async () => {
    const deleteAttempts: string[] = [];
    let corruptedDatabaseId: string | null = null;
    const harness = makeHarness({
      indexedDbActive: true,
      diag: { warn: vi.fn() },
      rotateIndexedDbVaultInstanceId: () => "2".repeat(32),
      indexedDbFactory: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        const originalDelete = store.delete.bind(store);
        return Object.assign(store, {
          delete: async (): Promise<void> => {
            deleteAttempts.push(databaseId);
            if (databaseId === corruptedDatabaseId) {
              throw new Error("UnknownError: Internal error.");
            }
            await originalDelete();
          },
        });
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      corruptedDatabaseId =
        state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      await state.reset();
      expect(harness.plugin.indexedDbVaultInstanceId).toBe("2".repeat(32));

      // Re-establish a fresh V2 authority under the rotated identity: the
      // normal load selects a brand-new database, not the orphaned one.
      harness.files.set(paths.stateV2ManifestFile, JSON.stringify(manifest()));
      harness.files.set(paths.stateV2File, JSON.stringify(envelope()));
      await state.load();

      const secondDatabaseId =
        state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      expect(secondDatabaseId).not.toBe("");
      expect(secondDatabaseId).not.toBe(corruptedDatabaseId);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();

      await expect(state.reset()).resolves.toBeUndefined();

      expect(harness.plugin.indexedDbVaultInstanceId).toBe("2".repeat(32));
      expect(deleteAttempts).toEqual([
        corruptedDatabaseId,
        secondDatabaseId,
      ]);
      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
    } finally {
      await state.close();
      for (const id of [corruptedDatabaseId, "2".repeat(32)]) {
        if (id) {
          await deleteDB(stateV2ActiveIndexedDbDatabaseName(id)).catch(
            () => undefined,
          );
        }
      }
    }
  });

  it("orphans the remote-scope evidence store and rotates when its delete fails during reset", async () => {
    const evidenceDeleteAttempts: string[] = [];
    const harness = makeHarness({
      indexedDbActive: true,
      diag: { warn: vi.fn() },
      rotateIndexedDbVaultInstanceId: () => "2".repeat(32),
      createRemoteScopeRecoveryEvidenceStore: (vaultInstanceId) => {
        const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
          vaultInstanceId,
        );
        return Object.assign(store, {
          delete: async (): Promise<void> => {
            evidenceDeleteAttempts.push(vaultInstanceId);
            throw new Error("UnknownError: Internal error.");
          },
        });
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      expect(state.activeV2StorageAuthorityEvidence.databaseId ?? "").not.toBe(
        "",
      );

      await expect(state.reset()).resolves.toBeUndefined();

      // The evidence delete failed once, the rescue rotated once, and the
      // remaining file-level cleanup still finished.
      expect(evidenceDeleteAttempts).toEqual(["1".repeat(32)]);
      expect(harness.plugin.indexedDbVaultInstanceId).toBe("2".repeat(32));
      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toBeNull();
      expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
      expect(harness.plugin.diag?.warn).toHaveBeenCalledWith(
        "state",
        expect.stringContaining("rotating the Vault instance identity"),
        expect.objectContaining({
          trigger: "remote-scope-evidence-delete",
        }),
      );
    } finally {
      await state.close();
      for (const id of ["1".repeat(32), "2".repeat(32)]) {
        await deleteDB(
          `easy-sync:scope-recovery:${id}`,
        ).catch(() => undefined);
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(id)).catch(
          () => undefined,
        );
      }
    }
  });

  it.each([
    { authorityKind: "indexeddb" as const, indexedDbActive: true },
    { authorityKind: "json" as const, indexedDbActive: false },
  ])("keeps one isolated ordinary-file ledger in the active V2 $authorityKind authority while resetting every other regenerable state", async ({ authorityKind, indexedDbActive }) => {
    const ancestorText = "0123456789";
    const ancestorHash = await sha256Hex(
      new TextEncoder().encode(ancestorText).buffer,
    );
    const committed = envelope();
    const retainedAnchor = committed.anchors.byAnchorId["file:file-a"];
    const retainedNode = committed.remoteIndex.itemsById[remoteA.driveId];
    if (!retainedAnchor || !retainedNode || retainedNode.kind !== "file") {
      throw new Error("fixture retained identity is missing");
    }
    retainedAnchor.contentHash = ancestorHash;
    retainedAnchor.ancestorHash = ancestorHash;
    retainedNode.contentHash = ancestorHash;
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-conservative-reset",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashB,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          sha256Hash: ancestorHash,
          size: remoteA.size,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      committed,
      indexedDbActive,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: "stale-conflict.md" }],
        "easy-sync-pending-deletes": [{ path: "stale-delete.md" }],
        "easy-sync-pending-issues": [{
          path: "stale-issue.md",
          actionType: SyncActionType.Upload,
          updatedAt: 1,
        }],
        "easy-sync-history": [{
          id: "history-before-reset",
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
          message: "old",
          files: [],
        }],
        "sync-interval": 15,
        "easy-sync-diagnostic-log": true,
      },
    });
    const state = new StateManager(harness.plugin);
    let reopened: StateManager | null = null;
    let databaseId = "";
    try {
      harness.folders.add(paths.ancestorsV2Dir);
      harness.files.set(
        `${paths.ancestorsV2Dir}/${ancestorHash}.txt`,
        ancestorText,
      );
      harness.files.set(paths.ancestorManifestV2File, JSON.stringify({
        schemaVersion: 2,
        textHashes: [ancestorHash],
      }));
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      expect(state.activeV2StorageAuthorityEvidence.kind).toBe(authorityKind);
      const before = state.getCommittedV2Envelope()!;
      harness.folders.add(paths.tmpDir);
      harness.folders.add(paths.logsDir);
      harness.files.set(`${paths.tmpDir}/downloads/note.md.part`, "partial");
      harness.files.set(`${paths.logsDir}/2026-08-16.jsonl`, "diagnostic");
      harness.files.set(paths.baseContentFile, JSON.stringify({
        [remoteA.path]: "base",
      }));
      harness.files.set(paths.scanCacheFile, "{}");
      harness.files.set(`${paths.pluginDir}/main.js`, "plugin");
      harness.files.set("Notes/user.md", "user");

      await state.resetPreservingIsolatedMutationRecovery([retained]);

      const after = state.getCommittedV2Envelope()!;
      expect(state.isV2StateActive).toBe(true);
      expect(after.scope).toEqual(before.scope);
      expect(after.meta.lifecycleEpoch).toBe(before.meta.lifecycleEpoch + 1);
      expect(after.meta.commitSeq).toBe(before.meta.commitSeq + 1);
      expect(after.remoteIndex.itemsById).toEqual({});
      expect(after.remoteIndex.deltaLink).toBeNull();
      expect(after.anchors.byAnchorId).toEqual(
        before.anchors.byAnchorId,
      );
      expect(after.folderAnchors?.byAnchorId).toEqual({});
      expect(after.communityPluginParticipation).toBeUndefined();
      expect(state.mutationLedger).toEqual([retained]);
      expect(state.boundAccountId).toBe(scope.accountId);
      expect(state.pendingConflicts).toEqual([]);
      expect(state.pendingRemoteDeletes).toEqual([]);
      expect(state.pendingIssues).toEqual([]);
      expect(state.syncHistory).toEqual([]);
      expect(state.activeV2StorageAuthorityEvidence.databaseId)
        .toBe(indexedDbActive ? databaseId : null);
      expect(harness.pluginData["sync-interval"]).toBe(15);
      expect(harness.pluginData["easy-sync-diagnostic-log"]).toBe(true);
      expect(harness.files.get(`${paths.logsDir}/2026-08-16.jsonl`))
        .toBe("diagnostic");
      expect(harness.files.get(`${paths.pluginDir}/main.js`)).toBe("plugin");
      expect(harness.files.get("Notes/user.md")).toBe("user");
      expect(harness.files.has(paths.baseContentFile)).toBe(false);
      expect(harness.files.has(paths.scanCacheFile)).toBe(false);
      expect(harness.files.get(
        `${paths.ancestorsV2Dir}/${ancestorHash}.txt`,
      )).toBe(ancestorText);
      expect(JSON.parse(
        harness.files.get(paths.ancestorManifestV2File)!,
      )).toEqual({
        schemaVersion: 2,
        textHashes: [ancestorHash],
      });
      expect([...harness.files.keys()].some((path) =>
        path.startsWith(`${paths.tmpDir}/`)
      )).toBe(false);

      await state.close();
      reopened = new StateManager(harness.plugin);
      await reopened.load();
      expect(reopened.isV2StateActive).toBe(true);
      expect(reopened.mutationLedger).toEqual([retained]);
      expect(reopened.getCommittedV2Envelope()).toEqual(after);
      expect(await reopened.getBaseContent(remoteA.path)).toBe(ancestorText);
      expect(reopened.activeV2StorageAuthorityEvidence.kind).toBe(authorityKind);
      expect(reopened.activeV2StorageAuthorityEvidence.databaseId)
        .toBe(indexedDbActive ? databaseId : null);
    } finally {
      await (reopened ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it.each([
    { authorityKind: "indexeddb" as const, indexedDbActive: true },
    { authorityKind: "json" as const, indexedDbActive: false },
  ])("preserves an exact ordered multi-record R3 capsule across a cold $authorityKind reopen", async ({ authorityKind, indexedDbActive }) => {
    const committed = envelope();
    const overwrite: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-overwrite",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const createdRemote: RemoteFileEntry = {
      path: "Notes/created.md",
      driveId: "file-created",
      parentId: folder.driveId,
      size: 12,
      mtime: 2,
      eTag: "etag-created",
      cTag: "ctag-created",
      sha256Hash: hashB,
    };
    const created: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-created-receipt",
        planRevision: 1,
        scope,
        action: "upload",
        path: createdRemote.path,
        expectedLocal: { exists: true, hash: hashB, size: 12 },
        expectedRemote: { exists: false },
        createdAt: 2,
      },
      receipt: {
        version: 1,
        operationId: "r3-created-receipt",
        completedAt: 3,
        checkpoint: {
          baseUpserts: [{
            path: createdRemote.path,
            hash: hashB,
            size: 12,
            eTag: createdRemote.eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [createdRemote],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };
    const deletedLocally: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-delete-local-post-state",
        planRevision: 1,
        scope,
        action: "deleteLocal",
        path: "Notes/deleted.md",
        expectedLocal: { exists: true, hash: hashA, size: 9 },
        expectedRemote: { exists: false },
        createdAt: 4,
      },
      receipt: {
        version: 1,
        operationId: "r3-delete-local-post-state",
        completedAt: 5,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: ["Notes/deleted.md"],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: ["Notes/deleted.md"],
        },
      },
    };
    const ledger = [overwrite, created, deletedLocally];
    const harness = makeHarness({
      committed,
      indexedDbActive,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": ledger,
        "easy-sync-pending-conflicts": [{ path: "stale.md" }],
      },
    });
    const state = new StateManager(harness.plugin);
    let reopened: StateManager | null = null;
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";

      await state.resetPreservingIsolatedMutationRecovery(ledger);

      const capsule = state.getCommittedV2Envelope()!;
      expect(capsule.remoteIndex.itemsById).toEqual({});
      expect(capsule.anchors.byAnchorId).toEqual({
        "file:file-a": committed.anchors.byAnchorId["file:file-a"],
      });
      expect(state.mutationLedger).toEqual(ledger);
      expect(state.pendingConflicts).toEqual([]);
      await state.close();

      reopened = new StateManager(harness.plugin);
      await reopened.load();
      expect(reopened.activeV2StorageAuthorityEvidence.kind)
        .toBe(authorityKind);
      expect(reopened.getCommittedV2Envelope()).toEqual(capsule);
      expect(reopened.mutationLedger).toEqual(ledger);
    } finally {
      await (reopened ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("rejects a stale same-identity anchor before conservative reset commits", async () => {
    const committed = envelope();
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-stale-anchor",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: "etag-not-the-anchor",
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: "must-stay.md" }],
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      const before = structuredClone(state.getCommittedV2Envelope()!);

      // The refusal has to stay self-describing: the reset button reaches this
      // gate, so a message that degrades to a bare "capsule" leaves the user
      // with nothing to act on. Pin the full shape, one known reason only.
      await expect(
        state.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow(
        /^Cannot conservatively reset without an exact V2 file identity capsule \((?:no committed V2 envelope|record is not admissible for conservative reset \([^)]+\)|authority holds or record identity closure failed)\)$/,
      );

      expect(state.getCommittedV2Envelope()).toEqual(before);
      expect(state.mutationLedger).toEqual([retained]);
      expect(state.pendingConflicts).toEqual([{ path: "must-stay.md" }]);
    } finally {
      await state.close();
    }
  });

  it("keeps reset read-only while a local replacement journal is pending", async () => {
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-pending-local-journal",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const journalPath = `${paths.tmpDir}/recovery/intent.json`;
    harness.files.set(journalPath, "pending");
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      const before = structuredClone(state.getCommittedV2Envelope()!);

      await expect(
        state.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow(/local file recovery/i);

      expect(harness.files.get(journalPath)).toBe("pending");
      expect(state.getCommittedV2Envelope()).toEqual(before);
      expect(state.mutationLedger).toEqual([retained]);
    } finally {
      await state.close();
    }
  });

  it("retires an already-reflected upload checkpoint without replaying stale remote facts", async () => {
    const committed = envelope();
    const anchor = committed.anchors.byAnchorId["file:file-a"]!;
    const node = committed.remoteIndex.itemsById[remoteA.driveId];
    if (!node || node.kind !== "file") throw new Error("file fixture missing");
    anchor.contentHash = hashB;
    anchor.size = remoteA.size;
    anchor.remoteETag = "etag-receipt";
    node.eTag = "etag-newer";
    node.contentHash = hashA;
    const receiptRemote: RemoteFileEntry = {
      ...remoteA,
      eTag: "etag-receipt",
      sha256Hash: hashB,
    };
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-upload-checkpoint-reflected",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "r3-upload-checkpoint-reflected",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: remoteA.path,
            hash: hashB,
            size: remoteA.size,
            eTag: receiptRemote.eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [receiptRemote],
          remoteDeletes: [],
          pendingConflictRemovals: [remoteA.path],
          pendingDeleteRemovals: [],
        },
      },
    };
    const harness = makeHarness({
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: remoteA.path }],
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      const before = structuredClone(state.getCommittedV2Envelope()!);

      expect(await state.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        before.meta.commitSeq,
      )).toBe(true);

      expect(state.mutationLedger).toEqual([]);
      expect(state.pendingConflicts).toEqual([]);
      const after = state.getCommittedV2Envelope()!;
      expect(after.meta.commitSeq).toBe(before.meta.commitSeq + 1);
      expect(after.meta.lifecycleEpoch).toBe(before.meta.lifecycleEpoch);
      expect(after.remoteIndex).toEqual(before.remoteIndex);
      expect(after.anchors).toEqual(before.anchors);
      expect(after.remoteIndex.itemsById[remoteA.driveId])
        .toMatchObject({ eTag: "etag-newer", contentHash: hashA });
    } finally {
      await state.close();
    }
  });

  it.each([
    { name: "receipt content does not match the intent", mismatchContent: true },
    { name: "receipt removes unrelated pending evidence", mismatchContent: false },
  ])("keeps a reflected checkpoint when $name", async ({ mismatchContent }) => {
    const committed = envelope();
    const anchor = committed.anchors.byAnchorId["file:file-a"]!;
    anchor.contentHash = hashB;
    anchor.size = remoteA.size;
    anchor.remoteETag = "etag-receipt";
    const receiptRemote: RemoteFileEntry = {
      ...remoteA,
      eTag: "etag-receipt",
      sha256Hash: hashB,
    };
    const unrelatedPath = "Notes/unrelated.md";
    const operationId = mismatchContent
      ? "r3-reflected-semantic-content-mismatch"
      : "r3-reflected-unrelated-pending-removal";
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId,
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: mismatchContent ? hashA : hashB,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: remoteA.path,
            hash: hashB,
            size: remoteA.size,
            eTag: receiptRemote.eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [receiptRemote],
          remoteDeletes: [],
          pendingConflictRemovals: [
            mismatchContent ? remoteA.path : unrelatedPath,
          ],
          pendingDeleteRemovals: [],
        },
      },
    };
    const pendingConflicts = [
      { path: remoteA.path },
      { path: unrelatedPath },
    ];
    const harness = makeHarness({
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": pendingConflicts,
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    const before = structuredClone(state.getCommittedV2Envelope()!);

    expect(await state.retireMutationCheckpointIfReflected(
      operationId,
      before.meta.commitSeq,
    )).toBe(false);
    await expect(state.commitMutationCheckpoint(operationId))
      .rejects.toThrow(/checkpoint evidence is invalid/i);

    expect(state.mutationLedger).toEqual([retained]);
    expect(state.pendingConflicts).toEqual(pendingConflicts);
    expect(state.getCommittedV2Envelope()).toEqual(before);
  });

  it("retires an already-reflected zero-anchor deleteLocal checkpoint", async () => {
    const committed = envelope();
    delete committed.anchors.byAnchorId["file:file-a"];
    delete committed.remoteIndex.itemsById[remoteA.driveId];
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-delete-local-checkpoint-reflected",
        planRevision: 1,
        scope,
        action: "deleteLocal",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "r3-delete-local-checkpoint-reflected",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [remoteA.path],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [remoteA.path],
        },
      },
    };
    const harness = makeHarness({
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-deletes": [{ path: remoteA.path }],
      },
    });
    const state = new StateManager(harness.plugin);
    try {
      await state.load();
      const before = structuredClone(state.getCommittedV2Envelope()!);

      expect(await state.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        before.meta.commitSeq,
      )).toBe(true);

      expect(state.mutationLedger).toEqual([]);
      expect(state.pendingRemoteDeletes).toEqual([]);
      const after = state.getCommittedV2Envelope()!;
      expect(after.meta.commitSeq).toBe(before.meta.commitSeq + 1);
      expect(after.meta.lifecycleEpoch).toBe(before.meta.lifecycleEpoch);
      expect(after.remoteIndex).toEqual(before.remoteIndex);
      expect(after.anchors).toEqual(before.anchors);
    } finally {
      await state.close();
    }
  });

  it.each([
    { authorityKind: "json" as const, indexedDbActive: false },
    { authorityKind: "indexeddb" as const, indexedDbActive: true },
  ])("keeps a reflected checkpoint when its $authorityKind authority disappears", async ({ indexedDbActive }) => {
    const committed = envelope();
    delete committed.anchors.byAnchorId["file:file-a"];
    delete committed.remoteIndex.itemsById[remoteA.driveId];
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-reflected-authority-missing",
        planRevision: 1,
        scope,
        action: "deleteLocal",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "r3-reflected-authority-missing",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [remoteA.path],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [remoteA.path],
        },
      },
    };
    const harness = makeHarness({
      committed,
      indexedDbActive,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-deletes": [{ path: remoteA.path }],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      const before = structuredClone(state.getCommittedV2Envelope()!);
      harness.files.delete(paths.stateV2ManifestFile);

      await expect(state.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        before.meta.commitSeq,
      )).rejects.toThrow(/manifest|authority/i);

      expect(state.mutationLedger).toEqual([retained]);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("retries reflected checkpoint retirement after PluginData persistence fails", async () => {
    const committed = envelope();
    delete committed.anchors.byAnchorId["file:file-a"];
    delete committed.remoteIndex.itemsById[remoteA.driveId];
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-reflected-plugin-data-retry",
        planRevision: 1,
        scope,
        action: "deleteLocal",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "r3-reflected-plugin-data-retry",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [remoteA.path],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [remoteA.path],
        },
      },
    };
    const harness = makeHarness({
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const active = new StateManager(harness.plugin);
    let reopened: StateManager | null = null;
    try {
      await active.load();
      vi.mocked(harness.plugin.updatePluginData)
        .mockRejectedValueOnce(new Error("interrupted ledger cleanup"));

      await expect(active.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        active.getCommittedV2Envelope()!.meta.commitSeq,
      )).rejects.toThrow("interrupted ledger cleanup");
      expect(active.mutationLedger).toEqual([retained]);
      await active.close();

      reopened = new StateManager(harness.plugin);
      await reopened.load();
      expect(await reopened.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        reopened.getCommittedV2Envelope()!.meta.commitSeq,
      )).toBe(true);
      expect(reopened.mutationLedger).toEqual([]);
    } finally {
      await (reopened ?? active).close();
    }
  });

  it("preserves the one exact merge-ready payload and rejects a missing payload before authority commit", async () => {
    const committed = envelope();
    const anchor = committed.anchors.byAnchorId["file:file-a"]!;
    anchor.ancestorHash = hashA;
    const targetBytes = new TextEncoder().encode("merged-r3").buffer;
    const target = {
      hash: await sha256Hex(targetBytes),
      size: targetBytes.byteLength,
    };
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-merge-ready",
        planRevision: 1,
        scope,
        action: "merge",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        target,
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      indexedDbActive: true,
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      const store = new MergeReadyStore(
        harness.plugin.app.vault.adapter,
        paths.tmpDir,
      );
      await store.prepare(retained.intent.operationId, targetBytes, target);
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";

      await state.resetPreservingIsolatedMutationRecovery([retained]);

      expect(await store.read(retained.intent.operationId, target))
        .not.toBeNull();
      expect(state.mutationLedger).toEqual([retained]);

      await store.complete(retained.intent.operationId);
      const before = state.getCommittedV2Envelope();
      await expect(
        state.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow(/merge payload/i);
      expect(state.getCommittedV2Envelope()).toEqual(before);
      expect(state.mutationLedger).toEqual([retained]);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("preserves a receipted remote-only merge payload across conservative reset", async () => {
    const committed = envelope();
    const targetBytes = new TextEncoder().encode("merged-r3-receipt").buffer;
    const target = {
      hash: await sha256Hex(targetBytes),
      size: targetBytes.byteLength,
    };
    const receiptRemote: RemoteFileEntry = {
      ...remoteA,
      size: target.size,
      eTag: "etag-merged-receipt",
      cTag: "ctag-merged-receipt",
      sha256Hash: target.hash,
    };
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "r3-receipted-merge-ready",
        planRevision: 1,
        scope,
        action: "merge",
        path: remoteA.path,
        expectedLocal: { exists: true, hash: hashB, size: remoteA.size },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        target,
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "r3-receipted-merge-ready",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [receiptRemote],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };
    const harness = makeHarness({
      indexedDbActive: true,
      committed,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      const store = new MergeReadyStore(
        harness.plugin.app.vault.adapter,
        paths.tmpDir,
      );
      await store.prepare(retained.intent.operationId, targetBytes, target);
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";

      await state.resetPreservingIsolatedMutationRecovery([retained]);

      expect(await store.read(retained.intent.operationId, target))
        .not.toBeNull();
      expect(state.mutationLedger).toEqual([retained]);
      expect(await state.retireMutationCheckpointIfReflected(
        retained.intent.operationId,
        state.getCommittedV2Envelope()!.meta.commitSeq,
      )).toBe(false);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("retries the conservative reset from its committed V2 capsule after PluginData cleanup was interrupted", async () => {
    const remoteChanged = envelope();
    const currentRemote = remoteChanged.remoteIndex.itemsById[remoteA.driveId];
    if (!currentRemote || currentRemote.kind !== "file") {
      throw new Error("fixture remote file is missing");
    }
    currentRemote.eTag = "etag-b";
    currentRemote.cTag = "ctag-b";
    currentRemote.contentHash = hashB;
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-conservative-reset-retry",
        planRevision: 1,
        scope,
        action: "download",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashA,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: "etag-b",
          size: remoteA.size,
          sha256Hash: hashB,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      committed: remoteChanged,
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: "stale.md" }],
      },
    });
    const active = new StateManager(harness.plugin);
    let retry: StateManager | null = null;
    let databaseId = "";
    try {
      await active.load();
      databaseId = active.activeV2StorageAuthorityEvidence.databaseId ?? "";
      const source = active.getCommittedV2Envelope()!;
      vi.mocked(harness.plugin.updatePluginData)
        .mockRejectedValueOnce(new Error("interrupted PluginData cleanup"));

      await expect(
        active.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow("interrupted PluginData cleanup");

      const committedCapsule = active.getCommittedV2Envelope()!;
      expect(committedCapsule.meta.lifecycleEpoch)
        .toBe(source.meta.lifecycleEpoch + 1);
      expect(committedCapsule.remoteIndex.itemsById).toEqual({});
      expect(active.mutationLedger).toEqual([retained]);
      await active.close();

      retry = new StateManager(harness.plugin);
      await retry.load();
      expect(retry.getCommittedV2Envelope()).toEqual(committedCapsule);
      expect(retry.mutationLedger).toEqual([retained]);

      await retry.resetPreservingIsolatedMutationRecovery([retained]);

      expect(retry.getCommittedV2Envelope()?.meta)
        .toEqual(committedCapsule.meta);
      expect(retry.pendingConflicts).toEqual([]);
      expect(retry.mutationLedger).toEqual([retained]);
    } finally {
      await (retry ?? active).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("drops a missing merge ancestor without blocking the exact file identity capsule", async () => {
    const ancestorText = "0123456789";
    const ancestorHash = await sha256Hex(
      new TextEncoder().encode(ancestorText).buffer,
    );
    const committed = envelope();
    const retainedAnchor = committed.anchors.byAnchorId["file:file-a"];
    const retainedNode = committed.remoteIndex.itemsById[remoteA.driveId];
    if (!retainedAnchor || !retainedNode || retainedNode.kind !== "file") {
      throw new Error("fixture retained identity is missing");
    }
    retainedAnchor.contentHash = ancestorHash;
    retainedAnchor.ancestorHash = ancestorHash;
    retainedNode.contentHash = ancestorHash;
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-missing-ancestor-cache",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashB,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: ancestorHash,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      committed,
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const state = new StateManager(harness.plugin);
    let reopened: StateManager | null = null;
    let databaseId = "";
    try {
      harness.folders.add(paths.ancestorsV2Dir);
      const ancestorPath =
        `${paths.ancestorsV2Dir}/${ancestorHash}.txt`;
      harness.files.set(ancestorPath, ancestorText);
      harness.files.set(paths.ancestorManifestV2File, JSON.stringify({
        schemaVersion: 2,
        textHashes: [ancestorHash],
      }));
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";

      // The active IndexedDB envelope remains healthy if this optional merge
      // cache disappears. Reset must retain the file identity, not turn the
      // missing regenerable body into a permanent blocker.
      harness.files.delete(ancestorPath);
      harness.files.delete(paths.ancestorManifestV2File);
      await state.resetPreservingIsolatedMutationRecovery([retained]);

      expect(state.getCommittedV2Envelope()?.anchors.byAnchorId[
        "file:file-a"
      ]?.ancestorHash).toBeUndefined();
      expect(state.mutationLedger).toEqual([retained]);
      await state.close();

      reopened = new StateManager(harness.plugin);
      await reopened.load();
      expect(reopened.isV2StateActive).toBe(true);
      expect(reopened.mutationLedger).toEqual([retained]);
      expect(await reopened.getBaseContent(remoteA.path)).toBeUndefined();
    } finally {
      await (reopened ?? state).close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("does not require a regenerable folder-anchor chain for one exact file capsule", async () => {
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-missing-parent-capsule",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashA,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: remoteA.sha256Hash,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const committed = envelope();
    committed.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: {},
    };
    const harness = makeHarness({
      committed,
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      await state.resetPreservingIsolatedMutationRecovery([retained]);

      expect(state.getCommittedV2Envelope()?.remoteIndex.itemsById)
        .toEqual({});
      expect(state.getCommittedV2Envelope()?.anchors.byAnchorId)
        .toHaveProperty("file:file-a");
      expect(state.getCommittedV2Envelope()?.folderAnchors?.byAnchorId)
        .toEqual({});
      expect(state.mutationLedger).toEqual([retained]);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it.each([
    ["manifest", paths.stateV2ManifestFile],
    ["authority witness", paths.stateV2AuthorityWitnessFile],
  ])("does not start a conservative reset after the durable V2 %s disappears", async (_label, authorityPath) => {
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-authority-preflight",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashB,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: "must-stay.md" }],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      const before = state.getCommittedV2Envelope();
      harness.files.delete(authorityPath);

      await expect(
        state.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow(/authority|manifest/i);

      expect(state.getCommittedV2Envelope()).toEqual(before);
      expect(state.mutationLedger).toEqual([retained]);
      expect(state.pendingConflicts).toEqual([{ path: "must-stay.md" }]);
    } finally {
      await state.close();
      if (databaseId) {
        await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      }
    }
  });

  it("does not report success when the V2 manifest disappears after the capsule commit", async () => {
    const retained: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-authority-postcondition",
        planRevision: 1,
        scope,
        action: "upload",
        path: remoteA.path,
        expectedLocal: {
          exists: true,
          hash: hashB,
          size: remoteA.size,
        },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: remoteA.eTag,
          size: remoteA.size,
          sha256Hash: hashA,
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const harness = makeHarness({
      indexedDbActive: true,
      pluginData: {
        "easy-sync-bound-account": scope.accountId,
        "easy-sync-v2-mutation-ledger": [retained],
        "easy-sync-pending-conflicts": [{ path: "stale.md" }],
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    try {
      await state.load();
      databaseId = state.activeV2StorageAuthorityEvidence.databaseId ?? "";
      vi.mocked(harness.plugin.updatePluginData).mockImplementation(
        async (mutator) => {
          mutator(harness.pluginData);
          harness.files.delete(paths.stateV2ManifestFile);
        },
      );

      await expect(
        state.resetPreservingIsolatedMutationRecovery([retained]),
      ).rejects.toThrow("final authority reload");

      expect(state.isV2StateActive).toBe(false);
      expect(state.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "authority-witness-manifest-missing",
      });
      expect(state.mutationLedger).toEqual([retained]);
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
});
