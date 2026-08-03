import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import {
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
} from "../src/sync/canonical-plan-v2";
import {
  canonicalEnvelopeDigest,
  IndexedDbStatePocStore,
  PocStateNotReadyError,
} from "./poc/indexeddb-state-poc";
import type {
  MutationIntentV1,
  MutationReceiptV1,
} from "../src/sync/types";
import {
  createLargeV2Envelope,
  LARGE_V2_FIXTURE_SCOPE,
} from "./helpers/large-v2-envelope";

const LARGE_FILE_COUNT = 50_000;

describe("isolated IndexedDB state-base POC", () => {
  it("round-trips the existing 50k fixture and preserves the canonical plan", async () => {
    const databaseName = uniqueDatabaseName("50k");
    const store = new IndexedDbStatePocStore(databaseName);
    try {
      const source = createLargeV2Envelope(LARGE_FILE_COUNT);
      const importStartedAt = performance.now();
      const imported = await store.importEnvelope(source);
      const importMs = performance.now() - importStartedAt;

      await store.close();
      const reopened = new IndexedDbStatePocStore(databaseName);
      const hydrateStartedAt = performance.now();
      const hydrated = await reopened.loadReadyEnvelope();
      const hydrateMs = performance.now() - hydrateStartedAt;

      expect(imported.counts).toEqual({
        remoteNodes: 50_001,
        anchors: 50_000,
        folderAnchors: 1,
        mutationLedger: 0,
      });
      expect(await canonicalEnvelopeDigest(hydrated)).toBe(imported.digest);

      const localFiles = Object.values(source.anchors.byAnchorId).map(
        (anchor) => ({
          path: anchor.lastPath,
          size: anchor.size,
          mtime: 1,
          hash: anchor.contentHash,
          binary: false,
        }),
      );
      const plannerInput = {
        localFiles,
        localFolders: [{ path: "Bulk" }],
        localFolderScanComplete: true,
        skippedLarge: [],
        configDir: ".obsidian",
        automaticDeleteLocalFiles: false,
      } as const;
      const sourcePlannerStartedAt = performance.now();
      const sourcePlan = buildCanonicalPlanCandidateV2({
        ...plannerInput,
        envelope: source,
      });
      const sourcePlannerMs = performance.now() - sourcePlannerStartedAt;
      const hydratedPlannerStartedAt = performance.now();
      const hydratedPlan = buildCanonicalPlanCandidateV2({
        ...plannerInput,
        envelope: hydrated,
      });
      const hydratedPlannerMs =
        performance.now() - hydratedPlannerStartedAt;
      const planDigest = (
        plan: ReturnType<typeof buildCanonicalPlanCandidateV2>,
      ) => canonicalPlanDigestV2({
        items: plan.items,
        lastTotalFiles: plan.lastTotalFiles,
        scope: plan.scope,
        sourceCommitSeq: plan.sourceCommitSeq,
      });
      expect(planDigest(hydratedPlan)).toBe(planDigest(sourcePlan));
      expect(hydratedPlan.status).toBe(sourcePlan.status);
      expect(hydratedPlan.sourceCommitSeq).toBe(sourcePlan.sourceCommitSeq);
      expect(hydratedPlan.lastTotalFiles).toBe(sourcePlan.lastTotalFiles);
      expect(hydratedPlan.items).toHaveLength(sourcePlan.items.length);

      console.log("[indexeddb-state-poc-50k]", JSON.stringify({
        schemaVersion: 1,
        files: LARGE_FILE_COUNT,
        counts: imported.counts,
        batches: imported.batches,
        importMs: Number(importMs.toFixed(3)),
        hydrateMs: Number(hydrateMs.toFixed(3)),
        sourcePlannerMs: Number(sourcePlannerMs.toFixed(3)),
        hydratedPlannerMs: Number(hydratedPlannerMs.toFixed(3)),
        logicalWrites: imported.logicalWrites,
        canonicalPlanItems: hydratedPlan.items.length,
      }));
      await reopened.close();
    } finally {
      await store.close();
      await IndexedDbStatePocStore.delete(databaseName);
    }
  }, 130_000);

  it("never promotes an interrupted staging import", async () => {
    const databaseName = uniqueDatabaseName("import-fail");
    const store = new IndexedDbStatePocStore(databaseName);
    try {
      await expect(store.importEnvelope(createLargeV2Envelope(2_500), {
        batchSize: 500,
        failpoint: { stage: "after-remote-batch", batch: 2 },
      })).rejects.toThrow("after-remote-batch:2");
      await store.close();

      const reopened = new IndexedDbStatePocStore(databaseName);
      const inspection = await reopened.inspect();
      expect(inspection.phase).toBe("importing");
      expect(inspection.counts.remoteNodes).toBe(1_000);
      expect(inspection.counts.anchors).toBe(0);
      await expect(reopened.loadReadyEnvelope()).rejects.toEqual(
        new PocStateNotReadyError("importing"),
      );
      await reopened.close();
    } finally {
      await store.close();
      await IndexedDbStatePocStore.delete(databaseName);
    }
  });

  it("keeps intent and receipt recoverable and commits only bounded records", async () => {
    const databaseName = uniqueDatabaseName("mutation");
    const source = createLargeV2Envelope(100);
    const operationId = "poc-upload-00000";
    const intent: MutationIntentV1 = {
      version: 1,
      operationId,
      planRevision: source.meta.commitSeq,
      scope: { ...LARGE_V2_FIXTURE_SCOPE },
      action: "upload",
      path: "Bulk/note-00000.md",
      expectedLocal: {
        exists: true,
        hash: "b".repeat(64),
        size: 2,
      },
      expectedRemote: {
        exists: true,
        driveId: "file-00000",
        eTag: "etag-00000",
        size: 1,
        sha256Hash: "a".repeat(64),
      },
      createdAt: 10,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId,
      completedAt: 11,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    const nextNode = {
      ...source.remoteIndex.itemsById["file-00000"]!,
      size: 2,
      eTag: "etag-next",
      contentHash: "b".repeat(64),
    };
    const nextAnchor = {
      ...source.anchors.byAnchorId["file:file-00000"]!,
      size: 2,
      remoteETag: "etag-next",
      contentHash: "b".repeat(64),
      confirmedAt: 12,
      confirmedBy: "upload-cas" as const,
    };

    const store = new IndexedDbStatePocStore(databaseName);
    try {
      await store.importEnvelope(source);
      await store.beginMutationIntent(intent);
      await store.close();

      const afterIntent = new IndexedDbStatePocStore(databaseName);
      expect(await afterIntent.getMutation(operationId)).toEqual({
        intent,
        receipt: null,
      });
      // A process loss after Graph returns but before the receipt is locally
      // durable has the same safe state: intent remains and external facts
      // must be re-observed before any retry.
      await afterIntent.close();

      const afterGraphReturn = new IndexedDbStatePocStore(databaseName);
      expect((await afterGraphReturn.getMutation(operationId))?.receipt)
        .toBeNull();
      await afterGraphReturn.recordMutationReceipt(receipt);
      await afterGraphReturn.close();

      const afterReceipt = new IndexedDbStatePocStore(databaseName);
      expect(await afterReceipt.getMutation(operationId)).toEqual({
        intent,
        receipt,
      });
      await expect(afterReceipt.finalizeMutation({
        operationId,
        remoteNode: nextNode,
        anchor: nextAnchor,
        committedAt: 12,
        failpoint: "after-anchor",
      })).rejects.toThrow("after-anchor");
      await afterReceipt.close();

      const afterAbortedFinalize = new IndexedDbStatePocStore(databaseName);
      const unchanged = await afterAbortedFinalize.loadReadyEnvelope();
      expect(unchanged.meta.commitSeq).toBe(3);
      expect(
        unchanged.remoteIndex.itemsById["file-00000"]?.eTag,
      ).toBe("etag-00000");
      expect(await afterAbortedFinalize.getMutation(operationId)).toEqual({
        intent,
        receipt,
      });

      const finalized = await afterAbortedFinalize.finalizeMutation({
        operationId,
        remoteNode: nextNode,
        anchor: nextAnchor,
        committedAt: 12,
      });
      expect(finalized).toEqual({ commitSeq: 4, logicalWrites: 4 });
      await afterAbortedFinalize.close();

      const committed = new IndexedDbStatePocStore(databaseName);
      const envelope = await committed.loadReadyEnvelope();
      expect(envelope.meta.commitSeq).toBe(4);
      expect(envelope.remoteIndex.itemsById["file-00000"]).toEqual(nextNode);
      expect(envelope.anchors.byAnchorId["file:file-00000"])
        .toEqual(nextAnchor);
      expect(await committed.getMutation(operationId)).toBeUndefined();
      expect((await committed.inspect()).counts).toEqual({
        remoteNodes: 101,
        anchors: 100,
        folderAnchors: 1,
        mutationLedger: 0,
      });
      await committed.close();
    } finally {
      await store.close();
      await IndexedDbStatePocStore.delete(databaseName);
    }
  });
});

function uniqueDatabaseName(suffix: string): string {
  return `easy-sync-indexeddb-poc-test-${suffix}-${crypto.randomUUID()}`;
}
