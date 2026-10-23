// IndexedDB 选取、丢失与重绑
// 由 tests/state-manager-v2.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  paths,
  scope,
  folder,
  envelope,
  makeHarness,
  uploadMutation,
} from "./helpers/state-manager-v2-harness";
import { deleteDB, openDB } from "idb";
import { StateManager } from "../src/sync/state-manager";
import type {
  FolderMutationIntentV2,
  MutationReceiptV1,
  RemoteFolderEntry,
} from "../src/sync/types";
import {
  StateV2IndexedDbActiveStore,
  stateV2ActiveIndexedDbDatabaseName,
} from "../src/sync/state-v2-indexeddb-active";

// Guard-2 coverage needs the derived replacement identity to collide with the
// selected one. Keep the real module everywhere else and force only the
// derivation result while this holder is populated.
const indexedDbActiveDerivation = vi.hoisted(() => ({
  forcedDatabaseId: null as string | null,
  calls: [] as Array<{
    stateDigest: string;
    previousDatabaseId?: string;
  }>,
}));

vi.mock("../src/sync/state-v2-indexeddb-active", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/sync/state-v2-indexeddb-active")
    >();
  return {
    ...actual,
    deriveStateV2ActiveIndexedDbDatabaseId: async (
      input: Parameters<
        typeof actual.deriveStateV2ActiveIndexedDbDatabaseId
      >[0],
    ) => {
      indexedDbActiveDerivation.calls.push({ ...input });
      return indexedDbActiveDerivation.forcedDatabaseId
        ?? actual.deriveStateV2ActiveIndexedDbDatabaseId(input);
    },
  };
});

describe("StateManager V2 production controller", () => {
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

  it("fails closed when a lost database rebuilds behind a witness authority raised past it", async () => {
    const constructedDatabaseIds: string[] = [];
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbFactory: (databaseId, recovery) => {
        constructedDatabaseIds.push(databaseId);
        return new StateV2IndexedDbActiveStore(databaseId, recovery);
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    let blocked: StateManager | null = null;
    try {
      await state.load();
      const witnessPath = paths.stateV2AuthorityWitnessFile;
      const witness = JSON.parse(harness.files.get(witnessPath)!);
      databaseId = witness.storageAuthority.databaseId;
      witness.storageAuthority.stateCommitSeq += 1;
      harness.files.set(witnessPath, JSON.stringify(witness));
      const witnessedRaw = harness.files.get(witnessPath)!;
      const committedRaw = harness.files.get(paths.stateV2File)!;
      await state.close();
      await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      constructedDatabaseIds.length = 0;

      blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      // Only the selected store was opened; guard 1 stopped the rebuild before
      // any replacement store or replacement witness existed.
      expect(constructedDatabaseIds).toEqual([databaseId]);
      expect(harness.files.get(witnessPath)).toBe(witnessedRaw);
      expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile))
        .toBe(false);
      expect(harness.files.get(paths.stateV2File)).toBe(committedRaw);
      expect(harness.readCommitted()).toEqual(envelope());
    } finally {
      await (blocked ?? state).close();
      if (databaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(databaseId),
        );
      }
    }
  });

  it("fails closed when a rebuilt replacement identity would not advance", async () => {
    const constructedDatabaseIds: string[] = [];
    const harness = makeHarness({
      indexedDbActive: true,
      indexedDbFactory: (databaseId, recovery) => {
        constructedDatabaseIds.push(databaseId);
        return new StateV2IndexedDbActiveStore(databaseId, recovery);
      },
    });
    const state = new StateManager(harness.plugin);
    let databaseId = "";
    let blocked: StateManager | null = null;
    try {
      await state.load();
      const witnessPath = paths.stateV2AuthorityWitnessFile;
      const witness = JSON.parse(harness.files.get(witnessPath)!);
      databaseId = witness.storageAuthority.databaseId;
      const witnessedRaw = harness.files.get(witnessPath)!;
      const committedRaw = harness.files.get(paths.stateV2File)!;
      await state.close();
      await deleteDB(stateV2ActiveIndexedDbDatabaseName(databaseId));
      constructedDatabaseIds.length = 0;
      const derivationCallCount = indexedDbActiveDerivation.calls.length;
      indexedDbActiveDerivation.forcedDatabaseId = databaseId;

      blocked = new StateManager(harness.plugin);
      await blocked.load();

      expect(blocked.isV2StateActive).toBe(false);
      expect(blocked.v2StateLoadRecoveryBlock).toMatchObject({
        authority: "v2",
        reason: "indexeddb-authority-recovery-failed",
      });
      // Guard 2 derived against the selected ID and refused before the
      // replacement store was constructed or the witness was replaced.
      expect(
        indexedDbActiveDerivation.calls
          .slice(derivationCallCount)
          .map((call) => call.previousDatabaseId),
      ).toContain(databaseId);
      expect(constructedDatabaseIds).toEqual([databaseId]);
      expect(harness.files.get(witnessPath)).toBe(witnessedRaw);
      expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile))
        .toBe(false);
      expect(harness.files.get(paths.stateV2File)).toBe(committedRaw);
      expect(harness.readCommitted()).toEqual(envelope());
    } finally {
      indexedDbActiveDerivation.forcedDatabaseId = null;
      await (blocked ?? state).close();
      if (databaseId) {
        await deleteDB(
          stateV2ActiveIndexedDbDatabaseName(databaseId),
        );
      }
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
});
