import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbPublic113StateStore,
} from "../src/sync/indexeddb-public-1-1-3-state";
import {
  buildCanonicalPlanCandidateFromStateV2,
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
} from "../src/sync/canonical-plan-v2";
import {
  createLargeV2Envelope,
} from "./helpers/large-v2-envelope";

const LARGE_FILE_COUNT = 50_000;
const sourceStateDigest = "d".repeat(64);

describe("public 1.1.3 IndexedDB canonical planner view", () => {
  it("plans the 50k fixture without hydrating a SyncStateEnvelopeV2", async () => {
    const databaseName =
      `easy-sync-public113-planner-50k:${crypto.randomUUID()}`;
    const source = createLargeV2Envelope(LARGE_FILE_COUNT);
    const store = new IndexedDbPublic113StateStore(databaseName);
    try {
      const importStartedAt = performance.now();
      const imported = await store.stageCandidate(source, {
        sourceStateDigest,
      });
      const importMs = performance.now() - importStartedAt;
      await store.close();

      const reopened = new IndexedDbPublic113StateStore(databaseName);
      const envelopeHydration = vi.spyOn(
        reopened,
        "loadPreparedCandidate",
      );
      const viewStartedAt = performance.now();
      const view = await reopened.loadPreparedPlannerView(
        sourceStateDigest,
      );
      const viewMs = performance.now() - viewStartedAt;
      expect(envelopeHydration).not.toHaveBeenCalled();
      expect(view.counts).toEqual({
        remoteNodes: 50_001,
        anchors: 50_000,
        folderAnchors: 1,
      });
      expect(view.state).not.toHaveProperty("envelope");
      expect(view.state.remoteNodes).toHaveLength(50_001);
      expect(view.state.fileAnchors).toHaveLength(50_000);

      const localFiles = source.anchors.byAnchorId
        ? Object.values(source.anchors.byAnchorId).map((anchor) => ({
            path: anchor.lastPath,
            size: anchor.size,
            mtime: 1,
            hash: anchor.contentHash,
            binary: false,
          }))
        : [];
      const plannerInput = {
        localFiles,
        localFolders: [{ path: "Bulk" }],
        localFolderScanComplete: true,
        skippedLarge: [],
        configDir: ".obsidian",
        automaticDeleteLocalFiles: false,
      } as const;
      const envelopePlanStartedAt = performance.now();
      const envelopePlan = buildCanonicalPlanCandidateV2({
        ...plannerInput,
        envelope: source,
      });
      const envelopePlanMs =
        performance.now() - envelopePlanStartedAt;
      const viewPlanStartedAt = performance.now();
      const viewPlan = buildCanonicalPlanCandidateFromStateV2({
        ...plannerInput,
        state: view.state,
      });
      const viewPlanMs = performance.now() - viewPlanStartedAt;

      expect(planDigest(viewPlan)).toBe(planDigest(envelopePlan));
      expect(viewPlan.status).toBe(envelopePlan.status);
      expect(viewPlan.items).toHaveLength(envelopePlan.items.length);
      expect(viewPlan.lastTotalFiles).toBe(LARGE_FILE_COUNT);
      expect(viewPlanMs).toBeLessThan(10_000);
      expect(envelopePlanMs).toBeLessThan(10_000);

      console.log("[indexeddb-public113-planner-view-50k]", JSON.stringify({
        schemaVersion: 1,
        files: LARGE_FILE_COUNT,
        counts: imported.counts,
        importMs: Number(importMs.toFixed(3)),
        viewMs: Number(viewMs.toFixed(3)),
        envelopePlanMs: Number(envelopePlanMs.toFixed(3)),
        viewPlanMs: Number(viewPlanMs.toFixed(3)),
        planItems: viewPlan.items.length,
        envelopeHydrations: envelopeHydration.mock.calls.length,
      }));
      await reopened.close();
    } finally {
      await store.delete();
    }
  }, 60_000);
});

function planDigest(
  plan: ReturnType<typeof buildCanonicalPlanCandidateV2>,
): string {
  return canonicalPlanDigestV2({
    items: plan.items,
    lastTotalFiles: plan.lastTotalFiles,
    scope: plan.scope,
    sourceCommitSeq: plan.sourceCommitSeq,
  });
}
