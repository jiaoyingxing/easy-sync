// 作用域保持、账本与持久回执
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
  makeHarness,
  uploadMutation,
  uploadMutationAt,
  localOnlyDownloadMutation,
} from "./helpers/state-manager-v2-harness";
import { StateManager } from "../src/sync/state-manager";
import { canonicalPlanDigestV2 } from "../src/sync/canonical-plan-v2";
import type {
  FolderMutationIntentV2,
  MutationLedgerEntryV1,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";

describe("StateManager V2 production controller", () => {
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

  it("pins the receipt-gate scope asymmetry: begin accepts a drifted-scope intent while the receipt stage refuses it", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutation();
    // Issue #17 conviction: intents carry the per-round observed scope while
    // the receipt gate compares against the committed envelope scope. An ID
    // case drift between the two sources strands the record at receipt=null
    // (begin has no scope gate; recordMutationReceipt does, against a
    // different scope source). R2 (scope-source unification) must flip this
    // pin; the control case with the matching scope passes elsewhere.
    const driftedIntent = {
      ...mutation.intent,
      operationId: "upload-scope-drift",
      scope: { ...scope, vaultFolderId: scope.vaultFolderId.toUpperCase() },
    };
    await state.beginMutationIntent(driftedIntent);
    await expect(
      state.recordMutationReceipt({
        ...mutation.receipt,
        operationId: driftedIntent.operationId,
      }),
    // The refusal reason discriminates root causes; a drifted scope must land
    // on the scope branch, not on the record-shape one.
    ).rejects.toThrow(
      /^Mutation receipt evidence is invalid \(scope does not match the committed envelope\): upload-scope-drift$/,
    );
    expect(state.mutationLedger).toEqual([{
      intent: driftedIntent,
      receipt: null,
    }]);
  });

  it("force reset terminates every unresolved record with one audit entry and rebuilds default state", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const first = uploadMutationAt(1);
    const second = uploadMutationAt(2);
    await state.beginMutationIntent(first.intent);
    await state.beginMutationIntent(second.intent);

    const audit = await state.forceReset();

    expect(audit).toEqual({
      at: expect.any(Number),
      ledgerCount: 2,
      quarantineCount: 0,
      corrupt: false,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(state.mutationRecoveryQuarantine).toEqual([]);
    expect(state.isV2StateActive).toBe(false);
    expect(state.forceResetAudit).toEqual(audit);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.forceResetAudit).toEqual(audit);
  });

  it("force reset terminates the public 1.1.3 ledger so a legacy device can leave the reset dead end", async () => {
    // F23 field shape: a device that never selected V2 authority keeps its
    // unreceipted intents in the public key, and every reset is refused by the
    // guard that reads that key. The user-authorized forced reset is the only
    // exit, so it must clear the slot the guard actually reads.
    const harness = makeHarness();
    harness.files.delete(paths.stateV2ManifestFile);
    harness.files.delete(paths.stateV2File);
    const legacyRecord = (index: number): MutationLedgerEntryV1 => ({
      intent: {
        version: 1,
        operationId: `download-legacy-${index}`,
        planRevision: 3,
        scope,
        action: "download",
        path: `Notes/legacy-${index}.md`,
        expectedLocal: { exists: true, hash: hashA, size: 10 },
        expectedRemote: {
          exists: true,
          driveId: `file-legacy-${index}`,
          eTag: `etag-legacy-${index}`,
          size: 11,
          sha256Hash: hashB,
        },
        createdAt: 10,
      },
      receipt: null,
    });
    harness.pluginData["easy-sync-mutation-ledger"] = [
      legacyRecord(1),
      legacyRecord(2),
    ];
    const state = new StateManager(harness.plugin);
    await state.load();
    expect(state.legacyAutoSyncAllowed).toBe(true);
    expect(state.isV2StateActive).toBe(false);
    expect(state.mutationLedger).toHaveLength(2);
    // Field evidence: an unauthorized reset must still refuse, and the refusal
    // is what the forced reset is authorized to terminate.
    await expect(state.reset()).rejects.toThrow(
      "Cannot reset while mutation recovery is unresolved",
    );

    const audit = await state.forceReset();

    expect(audit).toEqual({
      at: expect.any(Number),
      ledgerCount: 2,
      quarantineCount: 0,
      corrupt: false,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(harness.pluginData["easy-sync-mutation-ledger"]).toEqual([]);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"]).toEqual([]);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.isV2StateActive).toBe(false);
  });

  it("restores a corrupt mutation ledger from its checksummed backup", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutationAt(1);
    await state.beginMutationIntent(mutation.intent);

    const backupPath = `${paths.stateV2File}.ledger-backup`;
    expect(harness.files.has(backupPath)).toBe(true);

    // Corrupt the primary ledger copy while the backup stays intact.
    harness.pluginData["easy-sync-v2-mutation-ledger"] =
      "garbage-not-an-array";

    const restarted = new StateManager(harness.plugin);
    await restarted.load();

    expect(restarted.hasMutationLedgerCorruption).toBe(false);
    expect(restarted.mutationLedger).toHaveLength(1);
    expect(restarted.mutationLedger[0].intent.operationId)
      .toBe(mutation.intent.operationId);
  });

  it("stays fail-closed corrupt when no checksummed ledger backup exists", async () => {
    const harness = makeHarness({
      pluginData: {
        "easy-sync-v2-mutation-ledger": "garbage-not-an-array",
      },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    expect(state.hasMutationLedgerCorruption).toBe(true);
  });

  it("stays fail-closed corrupt when the checksummed ledger backup is also bad", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutationAt(1);
    await state.beginMutationIntent(mutation.intent);

    const backupPath = `${paths.stateV2File}.ledger-backup`;
    expect(harness.files.has(backupPath)).toBe(true);
    harness.files.set(backupPath, "garbage-backup");
    harness.pluginData["easy-sync-v2-mutation-ledger"] =
      "garbage-not-an-array";

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.hasMutationLedgerCorruption).toBe(true);
  });

  it("refuses a ledger backup whose digest no longer matches its entries", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutationAt(1);
    await state.beginMutationIntent(mutation.intent);

    const backupPath = `${paths.stateV2File}.ledger-backup`;
    const backup = JSON.parse(harness.files.get(backupPath)!);
    // Tamper with the entries while keeping the stored digest intact.
    backup.entries.push({ intent: "tampered" });
    harness.files.set(backupPath, JSON.stringify(backup));
    harness.pluginData["easy-sync-v2-mutation-ledger"] =
      "garbage-not-an-array";

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.hasMutationLedgerCorruption).toBe(true);
  });

  it("keeps the primary ledger commit when the backup write fails", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const mutation = uploadMutationAt(1);
    // Backup write is best-effort: fail it, the commit must still succeed.
    harness.rawAdapter.write.mockImplementationOnce(
      async (path: string) => {
        throw new Error(`injected backup write failure: ${path}`);
      },
    );

    await state.beginMutationIntent(mutation.intent);

    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].intent.operationId)
      .toBe(mutation.intent.operationId);
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

  it("retires exact intent-only uploads for an explicit scope exit without changing V2 file state", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const intent = uploadMutation().intent;
    await state.beginMutationIntent(intent);
    const sourceCommitSeq = harness.readCommitted().meta.commitSeq;
    const expected = structuredClone(state.mutationLedger);

    await expect(
      state.retireUnreceiptedMutationIntentsForScopeExit(expected),
    ).resolves.toBe(1);

    expect(state.mutationLedger).toEqual([]);
    expect(harness.pluginData["easy-sync-mutation-ledger"]).toEqual([]);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"]).toEqual([]);
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq);
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger).toEqual([]);
  });

  it("checkpoints a narrower scope while retaining its exact unresolved upload evidence", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const intent = uploadMutation().intent;
    await state.beginMutationIntent(intent);
    const expected = structuredClone(state.mutationLedger);
    const sourceCommitSeq = harness.readCommitted().meta.commitSeq;

    await state.commitSyncPathSettingsChange(
      () => false,
      (data) => {
        data["sync-community-plugins"] = false;
      },
      [],
      {
        previousSettingsFingerprint: "scope-open",
        targetSettingsFingerprint: "scope-closed",
        expandedFolderPaths: [],
        retainedMutationRecoveryScopeExit: expected,
      },
    );

    expect(state.syncPathSettingsFingerprint).toBe("scope-closed");
    expect(state.mutationLedger).toEqual(expected);
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq);
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.syncPathSettingsFingerprint).toBe("scope-closed");
    expect(restarted.mutationLedger).toEqual(expected);
  });

  it("allows an unrelated scope change while an ordinary file recovery remains included", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    await state.beginMutationIntent(uploadMutation().intent);
    const expected = structuredClone(state.mutationLedger);
    const sourceCommitSeq = harness.readCommitted().meta.commitSeq;

    await state.commitSyncPathSettingsChange(
      (path) => path === "Notes/new.md" || !path.startsWith("Private/"),
      (data) => {
        data["sync-excluded-folders"] = ["Private"];
      },
      undefined,
      {
        previousSettingsFingerprint: "before-unrelated-change",
        targetSettingsFingerprint: "after-unrelated-change",
        expandedFolderPaths: [],
      },
    );

    expect(state.syncPathSettingsFingerprint).toBe("after-unrelated-change");
    expect(state.mutationLedger).toEqual(expected);
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq);
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.syncPathSettingsFingerprint).toBe("after-unrelated-change");
    expect(restarted.mutationLedger).toEqual(expected);
  });

  it("still rejects a normal settings change that excludes the recovery path", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    await state.beginMutationIntent(uploadMutation().intent);
    const expected = structuredClone(state.mutationLedger);

    await expect(state.commitSyncPathSettingsChange(
      () => false,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "scope-open",
        targetSettingsFingerprint: "scope-excludes-recovery",
        expandedFolderPaths: [],
      },
    )).rejects.toThrow(
      "Cannot change sync paths while mutation recovery is unresolved",
    );

    expect(state.mutationLedger).toEqual(expected);
    expect(state.syncPathSettingsFingerprint).not.toBe(
      "scope-excludes-recovery",
    );
  });

  it("keeps folder recovery as a global settings lock", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const intent: FolderMutationIntentV2 = {
      version: 2,
      operationId: "pending-folder-create",
      planRevision: 1,
      scope,
      action: "createRemoteFolder",
      path: "Notes/New",
      expectedLocal: { exists: true },
      expectedRemote: { exists: false },
      expectedParent: {
        driveId: folder.driveId,
        path: folder.path,
      },
      createdAt: 1,
    };
    await state.beginMutationIntent(intent);

    await expect(state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "before-folder-recovery",
        targetSettingsFingerprint: "after-folder-recovery",
        expandedFolderPaths: [],
      },
    )).rejects.toThrow(
      "Cannot change sync paths while mutation recovery is unresolved",
    );

    expect(state.mutationLedger).toEqual([{ intent, receipt: null }]);
  });

  it("refuses a retained recovery checkpoint when the unresolved path remains in scope", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    await state.beginMutationIntent(uploadMutation().intent);
    const expected = structuredClone(state.mutationLedger);

    await expect(state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "scope-open",
        targetSettingsFingerprint: "scope-open",
        expandedFolderPaths: [],
        retainedMutationRecoveryScopeExit: expected,
      },
    )).rejects.toThrow(
      "Cannot change sync paths while mutation recovery is unresolved",
    );

    expect(state.syncPathSettingsFingerprint).not.toBe("scope-open");
    expect(state.mutationLedger).toEqual(expected);
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
    const metrics = await state.commitMutationCheckpoint(intent.operationId);

    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(remote);
    expect(state.baseSnapshot).toContainEqual(receipt.checkpoint.baseUpserts[0]);
    expect(harness.readCommitted().meta.commitSeq).toBe(4);
    expect(metrics).toEqual({
      operations: 1,
      ancestorPublishMs: expect.any(Number),
      v2CommitMs: expect.any(Number),
      ledgerClearMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(metrics.totalMs).toBeGreaterThanOrEqual(
      metrics.ancestorPublishMs + metrics.v2CommitMs + metrics.ledgerClearMs,
    );
  });

  it("loads and clears a receipted local-only download without changing ordinary V2 state", async () => {
    const mutation = localOnlyDownloadMutation();
    const harness = makeHarness({
      pluginData: {
        "easy-sync-mutation-ledger": [{
          intent: mutation.intent,
          receipt: mutation.receipt,
        }],
      },
    });
    const before = harness.readCommitted();
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.hasMutationLedgerCorruption).toBe(false);
    expect(state.mutationLedger).toEqual([mutation]);
    const baseBefore = structuredClone(state.baseSnapshot);
    const remoteBefore = structuredClone(state.remoteSnapshot);
    await state.commitMutationCheckpoint(mutation.intent.operationId);
    expect(state.mutationLedger).toEqual([]);
    expect(harness.readCommitted()).toEqual(before);
    expect(state.baseSnapshot).toEqual(baseBefore);
    expect(state.remoteSnapshot).toEqual(remoteBefore);
  });

  it("fails closed on an unknown or unbound file-intent state effect", async () => {
    const valid = localOnlyDownloadMutation();
    const candidates: unknown[] = [
      {
        ...valid.intent,
        stateEffect: "unknown-effect",
      },
      {
        ...valid.intent,
        sourcePath: "../escaped-object.bin",
      },
      {
        ...valid.intent,
        expectedRemote: {
          ...valid.intent.expectedRemote,
          sha256Hash: undefined,
        },
      },
    ];

    for (const intent of candidates) {
      const harness = makeHarness({
        pluginData: {
          "easy-sync-mutation-ledger": [{ intent, receipt: null }],
        },
      });
      const state = new StateManager(harness.plugin);
      await state.load();
      expect(state.hasMutationLedgerCorruption).toBe(true);
      expect(state.mutationLedger).toEqual([]);
    }
  });

  it("commits independent durable receipts in one V2 revision", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourceCommitSeq = harness.readCommitted().meta.commitSeq;
    const mutations = [0, 1, 2].map(uploadMutationAt);
    for (const mutation of mutations) {
      await state.beginMutationIntent(mutation.intent);
      await state.recordMutationReceipt(mutation.receipt);
    }

    const metrics = await state.commitMutationCheckpoints(
      mutations.map((mutation) => mutation.intent.operationId),
    );

    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toEqual(expect.arrayContaining(
      mutations.map((mutation) => mutation.remote),
    ));
    expect(state.baseSnapshot).toEqual(expect.arrayContaining(
      mutations.flatMap((mutation) => mutation.receipt.checkpoint.baseUpserts),
    ));
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq + 1);
    expect(metrics.operations).toBe(3);
  });

  it("retries only batch ledger cleanup when the shared V2 commit survived", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourceCommitSeq = harness.readCommitted().meta.commitSeq;
    const mutations = [0, 1].map(uploadMutationAt);
    for (const mutation of mutations) {
      await state.beginMutationIntent(mutation.intent);
      await state.recordMutationReceipt(mutation.receipt);
    }
    const operationIds = mutations.map(
      (mutation) => mutation.intent.operationId,
    );
    harness.plugin.updatePluginData = vi.fn().mockRejectedValueOnce(
      new Error("crash after batch V2 commit"),
    );

    await expect(state.commitMutationCheckpoints(operationIds))
      .rejects.toThrow("crash after batch V2 commit");
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq + 1);
    expect(state.mutationLedger).toHaveLength(2);

    harness.plugin.updatePluginData = vi.fn(
      async (mutator) => mutator(harness.pluginData),
    );
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    await expect(restarted.commitMutationCheckpoints(operationIds))
      .resolves.toMatchObject({ operations: 2 });
    expect(restarted.mutationLedger).toEqual([]);
    expect(harness.readCommitted().meta.commitSeq).toBe(sourceCommitSeq + 1);
  });
});
