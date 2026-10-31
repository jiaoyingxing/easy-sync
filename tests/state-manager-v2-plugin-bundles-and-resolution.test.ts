// 插件包结算与手动解决
// 由 tests/state-manager-v2.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  scope,
  hashA,
  hashB,
  folder,
  remoteA,
  envelope,
  makeHarness,
  uploadMutation,
  pluginBundleConflict,
  pluginBundleSettlementEntry,
  keepLocalPluginBundleSettlementEntry,
  pluginBundleEnvelope,
  receiptedPluginBundleSettlementEntry,
} from "./helpers/state-manager-v2-harness";
import { StateManager } from "../src/sync/state-manager";
import type {
  FileConsolidationSettlementV2,
  ManualMutationResolutionV1,
  MutationIntentV1,
  MutationReceiptV1,
  RemoteFileEntry,
} from "../src/sync/types";

describe("StateManager V2 production controller", () => {
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

  it("atomically persists one keep-remote plugin bundle choice without retiring its predecessors", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const pluginRoot = ".obsidian/plugins/resojot";
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "unknown-resojot-main-upload",
      path: `${pluginRoot}/main.js`,
      createdAt: 10,
    };
    await state.beginMutationIntent(predecessorIntent);
    const conflict = pluginBundleConflict();
    await state.upsertPendingConflicts([conflict]);
    const bundleEntry = pluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    const expectedPredecessors = structuredClone(state.mutationLedger);

    await expect(state.beginCommunityPluginBundleSettlement(
      expectedPredecessors,
      [structuredClone(conflict)],
      bundleEntry,
    )).resolves.toBe(true);

    expect(state.mutationLedger).toEqual([
      { intent: predecessorIntent, receipt: null },
      bundleEntry,
    ]);
    expect(state.pendingConflicts).toEqual([conflict]);
    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.hasMutationLedgerCorruption).toBe(false);
    expect(restarted.mutationLedger).toEqual(state.mutationLedger);
    expect(restarted.pendingConflicts).toEqual([conflict]);
    await expect(restarted.beginCommunityPluginBundleSettlement(
      expectedPredecessors,
      [structuredClone(conflict)],
      bundleEntry,
    )).resolves.toBe(true);
    expect(restarted.mutationLedger).toHaveLength(2);
  });

  it("persists one keep-local plugin choice and its member receipts incrementally", async () => {
    const harness = makeHarness({ committed: pluginBundleEnvelope() });
    const state = new StateManager(harness.plugin);
    await state.load();
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "unknown-resojot-main-upload",
      path: ".obsidian/plugins/resojot/main.js",
      createdAt: 10,
    };
    await state.beginMutationIntent(predecessorIntent);
    const conflict = pluginBundleConflict();
    await state.upsertPendingConflicts([conflict]);
    const entry = keepLocalPluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    await state.beginCommunityPluginBundleSettlement(
      [{ intent: predecessorIntent, receipt: null }],
      [structuredClone(conflict)],
      entry,
    );
    const remoteReceipts = receiptedPluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    ).manualResolution;
    const settlement = entry.manualResolution;
    if (
      !settlement
      || settlement.version !== 2
      || !remoteReceipts
      || remoteReceipts.version !== 2
    ) throw new Error("bundle fixture missing");
    const receipts = settlement.members.map((member, index) => ({
      ...remoteReceipts.members[index].receipt!,
      operationId: member.intent.operationId,
    }));

    await expect(state.recordCommunityPluginBundleSettlementReceipts(
      entry,
      [receipts[0]],
    )).resolves.toBe(true);
    const partiallyReceipted = state.mutationLedger.find(
      (candidate) => candidate.intent.operationId === entry.intent.operationId,
    )!;
    expect(partiallyReceipted.manualResolution?.version === 2
      ? partiallyReceipted.manualResolution.members.map((member) => Boolean(member.receipt))
      : []).toEqual([true, false]);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.hasMutationLedgerCorruption).toBe(false);
    const persisted = restarted.mutationLedger.find(
      (candidate) => candidate.intent.operationId === entry.intent.operationId,
    )!;
    await expect(restarted.recordCommunityPluginBundleSettlementReceipts(
      persisted,
      [receipts[1]],
    )).resolves.toBe(true);
    const completed = restarted.mutationLedger.find(
      (candidate) => candidate.intent.operationId === entry.intent.operationId,
    )!;
    expect(completed.manualResolution?.version === 2
      ? completed.manualResolution.members.map((member) => Boolean(member.receipt))
      : []).toEqual([true, true]);
  });

  it("fails closed when a future plugin bundle settlement version is unreadable", async () => {
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "future-bundle-predecessor",
      path: ".obsidian/plugins/resojot/main.js",
    };
    const conflict = pluginBundleConflict();
    const future = structuredClone(
      pluginBundleSettlementEntry(predecessorIntent, conflict),
    ) as unknown as { manualResolution: { version: number } };
    future.manualResolution.version = 99;
    const harness = makeHarness({
      pluginData: {
        "easy-sync-v2-mutation-ledger": [
          { intent: predecessorIntent, receipt: null },
          future,
        ],
      },
    });
    const state = new StateManager(harness.plugin);

    await state.load();

    expect(state.hasMutationLedgerCorruption).toBe(true);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps plugin bundle predecessors and conflicts when the bundle choice write fails", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "unknown-plugin-upload",
      path: ".obsidian/plugins/resojot/main.js",
    };
    await state.beginMutationIntent(predecessorIntent);
    const conflict = pluginBundleConflict();
    await state.upsertPendingConflicts([conflict]);
    const beforeLedger = structuredClone(state.mutationLedger);
    const beforeConflicts = structuredClone(state.pendingConflicts);
    harness.plugin.updatePluginData = vi.fn().mockRejectedValueOnce(
      new Error("plugin data write failed"),
    );

    await expect(state.beginCommunityPluginBundleSettlement(
      beforeLedger,
      beforeConflicts,
      pluginBundleSettlementEntry(predecessorIntent, conflict),
    )).rejects.toThrow("plugin data write failed");

    expect(state.mutationLedger).toEqual(beforeLedger);
    expect(state.pendingConflicts).toEqual(beforeConflicts);
  });

  it("persists all plugin bundle receipts together and checkpoints one reviewed remote bundle", async () => {
    const harness = makeHarness({ committed: pluginBundleEnvelope() });
    const state = new StateManager(harness.plugin);
    await state.load();
    const pluginRoot = ".obsidian/plugins/resojot";
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "unknown-resojot-main-upload",
      path: `${pluginRoot}/main.js`,
      createdAt: 10,
    };
    const unrelatedIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "unrelated-note-upload",
      createdAt: 11,
    };
    await state.beginMutationIntent(predecessorIntent);
    await state.beginMutationIntent(unrelatedIntent);
    const conflict = pluginBundleConflict();
    await state.upsertPendingConflicts([conflict]);
    const unreceipted = pluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    await expect(state.beginCommunityPluginBundleSettlement(
      [{ intent: predecessorIntent, receipt: null }],
      [structuredClone(conflict)],
      unreceipted,
    )).resolves.toBe(true);
    expect(state.mutationLedger.map((entry) => entry.intent.operationId))
      .toEqual([
        predecessorIntent.operationId,
        unrelatedIntent.operationId,
        unreceipted.intent.operationId,
      ]);

    const receipted = receiptedPluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    const settlement = receipted.manualResolution;
    if (!settlement || settlement.version !== 2) throw new Error("bundle fixture missing");
    await expect(state.recordCommunityPluginBundleSettlementReceipts(
      unreceipted,
      settlement.members.map((member) => member.receipt!),
    )).resolves.toBe(true);
    expect(state.mutationLedger.find(
      (entry) => entry.intent.operationId === unreceipted.intent.operationId,
    )).toEqual(receipted);

    await state.commitCommunityPluginBundleSettlementCheckpoint(receipted);

    expect(state.mutationLedger).toEqual([
      { intent: unrelatedIntent, receipt: null },
    ]);
    expect(state.pendingConflicts).toEqual([]);
    expect(state.baseSnapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `${pluginRoot}/main.js`,
        hash: hashA,
        eTag: "etag-resojot-main",
      }),
      expect.objectContaining({
        path: `${pluginRoot}/manifest.json`,
        hash: hashB,
        eTag: "etag-resojot-manifest",
      }),
    ]));
    expect(harness.readCommitted().meta.commitSeq).toBe(4);
  });

  it("keeps the complete plugin bundle settlement when one bound conflict changes", async () => {
    const harness = makeHarness({ committed: pluginBundleEnvelope() });
    const state = new StateManager(harness.plugin);
    await state.load();
    const predecessorIntent: MutationIntentV1 = {
      ...uploadMutation().intent,
      operationId: "changed-conflict-predecessor",
      path: ".obsidian/plugins/resojot/main.js",
    };
    await state.beginMutationIntent(predecessorIntent);
    const conflict = pluginBundleConflict();
    await state.upsertPendingConflicts([conflict]);
    const unreceipted = pluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    await state.beginCommunityPluginBundleSettlement(
      [{ intent: predecessorIntent, receipt: null }],
      [structuredClone(conflict)],
      unreceipted,
    );
    const receipted = receiptedPluginBundleSettlementEntry(
      predecessorIntent,
      conflict,
    );
    const settlement = receipted.manualResolution;
    if (!settlement || settlement.version !== 2) throw new Error("bundle fixture missing");
    await state.recordCommunityPluginBundleSettlementReceipts(
      unreceipted,
      settlement.members.map((member) => member.receipt!),
    );
    await state.upsertPendingConflicts([{
      ...conflict,
      decisionToken: {
        ...conflict.decisionToken!,
        ancestorHash: "changed",
      },
    }]);

    await expect(state.commitCommunityPluginBundleSettlementCheckpoint(
      receipted,
    )).rejects.toThrow("conflict changed");

    expect(state.mutationLedger).toHaveLength(2);
    expect(state.pendingConflicts).toHaveLength(1);
    expect(harness.readCommitted().meta.commitSeq).toBe(3);
  });

  it("persists and atomically checkpoints the exact receipted-rename collision recovery", async () => {
    const sourcePath = remoteA.path;
    const targetPath = "Notes/b.md";
    const committed = envelope();
    committed.anchors.byAnchorId["file:stale-target"] = {
      anchorId: "file:stale-target",
      remoteId: "stale-target",
      lastPath: targetPath,
      contentHash: hashB,
      size: 12,
      remoteETag: "etag-stale-target",
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "blocked-receipted-rename",
      planRevision: 2,
      scope,
      action: "renameRemote",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
        sha256Hash: hashA,
      },
      createdAt: 10,
    };
    const movedRemote: RemoteFileEntry = {
      ...remoteA,
      path: targetPath,
      eTag: "etag-moved",
    };
    const sourceReceipt: MutationReceiptV1 = {
      version: 1,
      operationId: sourceIntent.operationId,
      completedAt: 20,
      checkpoint: {
        baseUpserts: [{
          path: targetPath,
          hash: hashA,
          size: remoteA.size,
          eTag: movedRemote.eTag,
        }],
        baseRemovals: [sourcePath],
        remoteUpserts: [movedRemote],
        remoteDeletes: [sourcePath],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    await state.beginMutationIntent(sourceIntent);
    await state.recordMutationReceipt(sourceReceipt);

    const manualIntent: MutationIntentV1 = {
      ...sourceIntent,
      operationId: "manual-replacement-upload",
      action: "upload",
      expectedRemote: { exists: false },
      createdAt: 30,
    };
    const recoveryEvidence = {
      kind: "receipted-rename-target-anchor-collision" as const,
      lifecycleEpoch: committed.meta.lifecycleEpoch,
      sourceCommitSeq: committed.meta.commitSeq,
      sourceAnchorId: `file:${remoteA.driveId}`,
      targetAnchorId: "file:stale-target",
      staleRemoteIds: [remoteA.driveId, "stale-target"].sort(),
    };
    const resolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-local",
      factsDigest: "9".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      recoveryEvidence,
      intent: manualIntent,
      receipt: null,
    };
    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      resolution,
    )).resolves.toBe(true);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    expect(restarted.mutationLedger[0]?.manualResolution).toMatchObject({
      recoveryEvidence,
      intent: { action: "upload", sourcePath, path: targetPath },
    });

    const uploaded: RemoteFileEntry = {
      ...movedRemote,
      driveId: "replacement-upload",
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
    };
    const manualReceipt: MutationReceiptV1 = {
      version: 1,
      operationId: manualIntent.operationId,
      completedAt: 40,
      checkpoint: {
        baseUpserts: [{
          path: targetPath,
          hash: hashA,
          size: remoteA.size,
          eTag: uploaded.eTag,
        }],
        baseRemovals: [sourcePath],
        remoteUpserts: [uploaded],
        remoteDeletes: [sourcePath],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    await restarted.recordManualMutationResolutionReceipt(
      sourceIntent.operationId,
      manualReceipt,
    );
    await restarted.commitManualMutationResolutionCheckpoint(sourceIntent.operationId);

    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.remoteSnapshot).toEqual([uploaded]);
    expect(restarted.baseSnapshot).toEqual(manualReceipt.checkpoint.baseUpserts);
    expect(Object.values(harness.readCommitted().anchors.byAnchorId)).toEqual([
      expect.objectContaining({ remoteId: uploaded.driveId, lastPath: targetPath }),
    ]);
  });

  it("accepts and applies a state-only converged sourcePath settlement", async () => {
    const committed = envelope();
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();

    const sourcePath = remoteA.path;
    const targetPath = "Notes/b.md";
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "converged-move",
      planRevision: 2,
      scope,
      action: "moveLocal",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
        sha256Hash: hashA,
      },
      createdAt: 10,
    };
    await state.beginMutationIntent(sourceIntent);

    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "file-b",
      parentId: folder.driveId,
      size: remoteA.size,
      mtime: 40,
      eTag: "etag-b",
      cTag: "ctag-b",
      sha256Hash: hashA,
    };
    const manualIntent: MutationIntentV1 = {
      version: 1,
      operationId: "manual-converged-upload",
      planRevision: 2,
      scope,
      action: "upload",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
      expectedRemote: {
        exists: true,
        driveId: targetRemote.driveId,
        eTag: targetRemote.eTag,
        size: targetRemote.size,
        sha256Hash: hashA,
      },
      createdAt: 30,
    };
    const manualReceipt: MutationReceiptV1 = {
      version: 1,
      operationId: manualIntent.operationId,
      completedAt: 40,
      checkpoint: {
        baseUpserts: [{
          path: targetPath,
          hash: hashA,
          size: remoteA.size,
          eTag: targetRemote.eTag,
        }],
        baseRemovals: [sourcePath],
        remoteUpserts: [targetRemote],
        remoteDeletes: [sourcePath],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    const resolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-local",
      factsDigest: "c".repeat(64),
      selectedAt: 30,
      externalMutation: false,
      intent: manualIntent,
      receipt: manualReceipt,
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      resolution,
    )).resolves.toBe(true);

    const restarted = new StateManager(harness.plugin);
    await restarted.load();
    await restarted.commitManualMutationResolutionCheckpoint(
      sourceIntent.operationId,
    );

    expect(restarted.mutationLedger).toEqual([]);
    expect(restarted.remoteSnapshot).toEqual([targetRemote]);
    expect(restarted.baseSnapshot).toEqual(manualReceipt.checkpoint.baseUpserts);
    expect(Object.values(harness.readCommitted().anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        remoteId: targetRemote.driveId,
        lastPath: targetPath,
      }),
    ]);
  });

  it("rejects collision recovery evidence when the outer rename has no receipt", async () => {
    const committed = envelope();
    committed.anchors.byAnchorId["file:stale-target"] = {
      anchorId: "file:stale-target",
      remoteId: "stale-target",
      lastPath: "Notes/b.md",
      contentHash: hashB,
      size: 12,
      remoteETag: "etag-stale-target",
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    const harness = makeHarness({ committed });
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "unreceipted-rename",
      planRevision: 2,
      scope,
      action: "renameRemote",
      path: "Notes/b.md",
      sourcePath: remoteA.path,
      expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
      },
      createdAt: 10,
    };
    await state.beginMutationIntent(sourceIntent);
    const resolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-local",
      factsDigest: "8".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      recoveryEvidence: {
        kind: "receipted-rename-target-anchor-collision",
        lifecycleEpoch: committed.meta.lifecycleEpoch,
        sourceCommitSeq: committed.meta.commitSeq,
        sourceAnchorId: `file:${remoteA.driveId}`,
        targetAnchorId: "file:stale-target",
        staleRemoteIds: [remoteA.driveId, "stale-target"].sort(),
      },
      intent: {
        ...sourceIntent,
        operationId: "invalid-manual-upload",
        action: "upload",
        expectedRemote: { exists: false },
        createdAt: 30,
      },
      receipt: null,
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      resolution,
    )).rejects.toThrow("evidence is invalid");
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

  it("accepts a one-surviving-copy download on a move record (2026-10-31)", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourcePath = remoteA.path;
    const targetPath = "Notes/心理学习/情感勒索.md";
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "blocked-rename",
      planRevision: 2,
      scope,
      action: "renameRemote",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
      },
      createdAt: 10,
    };
    await state.beginMutationIntent(sourceIntent);
    const resolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-remote",
      factsDigest: "a".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      intent: {
        ...sourceIntent,
        operationId: "manual-restore",
        path: sourcePath,
        sourcePath: undefined,
        action: "download",
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: "etag-current",
          size: remoteA.size,
        },
        createdAt: 30,
      },
      receipt: null,
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      resolution,
    )).resolves.toBe(true);
  });

  it("rejects a one-copy move choice whose action contradicts the surviving side", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourcePath = remoteA.path;
    const targetPath = "Notes/心理学习/情感勒索.md";
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "blocked-rename",
      planRevision: 2,
      scope,
      action: "renameRemote",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: false },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
      },
      createdAt: 10,
    };
    await state.beginMutationIntent(sourceIntent);
    const contradictory: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-remote",
      factsDigest: "b".repeat(64),
      selectedAt: 30,
      externalMutation: true,
      intent: {
        ...sourceIntent,
        operationId: "manual-wrong-direction",
        path: sourcePath,
        sourcePath: undefined,
        action: "deleteRemote",
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: remoteA.driveId,
          eTag: "etag-current",
          size: remoteA.size,
        },
        createdAt: 30,
      },
      receipt: null,
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      contradictory,
    )).rejects.toThrow("evidence is invalid");
  });

  it("records both steps before committing a diverged-move consolidation", async () => {
    const harness = makeHarness();
    const state = new StateManager(harness.plugin);
    await state.load();
    const sourcePath = remoteA.path;
    const targetPath = "Notes/b.md";
    const sourceIntent: MutationIntentV1 = {
      version: 1,
      operationId: "diverged-rename",
      planRevision: 1,
      scope,
      action: "renameRemote",
      path: targetPath,
      sourcePath,
      expectedLocal: { exists: true, hash: hashB, size: 7 },
      expectedRemote: {
        exists: true,
        driveId: remoteA.driveId,
        eTag: remoteA.eTag,
        size: remoteA.size,
      },
      createdAt: 1,
    };
    await state.beginMutationIntent(sourceIntent);
    const settlement: FileConsolidationSettlementV2 = {
      version: 2,
      kind: "file-consolidation",
      choice: "keep-remote",
      factsDigest: "c".repeat(64),
      selectedAt: 5,
      externalMutation: true,
      steps: [
        {
          intent: {
            ...sourceIntent,
            operationId: "diverged-create",
            action: "download",
            path: sourcePath,
            sourcePath: undefined,
            expectedLocal: { exists: false },
            expectedRemote: {
              exists: true,
              driveId: remoteA.driveId,
              eTag: remoteA.eTag,
              size: remoteA.size,
            },
            createdAt: 5,
          },
          receipt: null,
        },
        {
          intent: {
            ...sourceIntent,
            operationId: "diverged-delete",
            action: "deleteLocal",
            path: targetPath,
            sourcePath: undefined,
            expectedLocal: { exists: true, hash: hashB, size: 7 },
            expectedRemote: { exists: false },
            createdAt: 5,
          },
          receipt: null,
        },
      ],
    };

    await expect(state.attachManualMutationResolution(
      structuredClone(state.mutationLedger[0]),
      settlement,
    )).resolves.toBe(true);
    await expect(state.commitManualMutationResolutionCheckpoint(
      sourceIntent.operationId,
    )).rejects.toThrow("steps are incomplete");

    await state.recordFileConsolidationStepReceipt(
      sourceIntent.operationId,
      0,
      {
        version: 1,
        operationId: "diverged-create",
        completedAt: 10,
        checkpoint: {
          baseUpserts: [{
            path: sourcePath,
            hash: hashA,
            size: remoteA.size,
            eTag: remoteA.eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    );
    await expect(state.commitManualMutationResolutionCheckpoint(
      sourceIntent.operationId,
    )).rejects.toThrow("steps are incomplete");

    await state.recordFileConsolidationStepReceipt(
      sourceIntent.operationId,
      1,
      {
        version: 1,
        operationId: "diverged-delete",
        completedAt: 11,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [targetPath],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    );
    await state.commitManualMutationResolutionCheckpoint(sourceIntent.operationId);

    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual(expect.objectContaining({
      path: sourcePath,
      hash: hashA,
    }));
    expect(state.manualMutationResolutionAudit.slice(-1)[0]).toMatchObject({
      sourceOperationId: sourceIntent.operationId,
      resolutionOperationId: `${sourceIntent.operationId}-consolidation`,
      choice: "keep-remote",
      action: "upload",
      externalMutation: true,
    });
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
});
