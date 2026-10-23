// 权威见证、降级拦截与损坏发布恢复
// 由 tests/state-manager-v2.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  paths,
  scope,
  hashA,
  folder,
  remoteA,
  envelope,
  manifest,
  makeHarness,
} from "./helpers/state-manager-v2-harness";
import { StateManager } from "../src/sync/state-manager";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import type {
  FolderMutationIntentV2,
  MutationLedgerEntryV1,
  SyncPlanItem,
} from "../src/sync/types";
import { StateV2IndexedDbActiveStore } from "../src/sync/state-v2-indexeddb-active";

describe("StateManager V2 production controller", () => {
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

describe("folder recovery settle-as-observed (zero-write manual exit)", () => {
  const folderIntent = (): FolderMutationIntentV2 => ({
    version: 2,
    operationId: "stuck-folder-op",
    planRevision: 1,
    scope,
    action: "createRemoteFolder",
    path: "Notes/new-sub",
    expectedLocal: { exists: true },
    expectedRemote: {
      exists: true,
      driveId: "folder-created",
      parentId: folder.driveId,
      eTag: "etag-created",
    },
    expectedParent: { driveId: folder.driveId, path: "Notes" },
    createdAt: 1,
  });

  const blockedFolderRecord = (): MutationLedgerEntryV1 => ({
    intent: folderIntent(),
    receipt: {
      version: 1,
      operationId: folderIntent().operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        folderUpserts: [{
          path: "Notes/new-sub",
          driveId: "folder-created",
          parentId: folder.driveId,
          name: "new-sub",
          eTag: "etag-created",
        }],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    },
  });

  it("retires exactly the reviewed folder record, audits as-observed, and never touches the envelope", async () => {
    const record = blockedFolderRecord();
    const harness = makeHarness({
      pluginData: { "easy-sync-v2-mutation-ledger": [record] },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    const beforeEnvelope = state.getCommittedV2Envelope();
    expect(state.mutationLedger).toHaveLength(1);

    const settled = await state.settleFolderMutationRecoveryAsObserved({
      expectedRecord: structuredClone(record),
    });

    expect(settled).toBe(true);
    expect(state.mutationLedger).toHaveLength(0);
    expect(state.manualMutationResolutionAudit.at(-1)).toMatchObject({
      version: 1,
      sourceOperationId: "stuck-folder-op",
      resolutionOperationId: "stuck-folder-op-auto-observed-settle",
      path: "Notes/new-sub",
      choice: "as-observed",
      action: "createRemoteFolder",
      externalMutation: false,
    });
    expect(state.getCommittedV2Envelope()).toEqual(beforeEnvelope);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"]).toEqual([]);

    // The record CAS: a stale record copy settles nothing.
    const again = await state.settleFolderMutationRecoveryAsObserved({
      expectedRecord: structuredClone(record),
    });
    expect(again).toBe(false);
    expect(state.manualMutationResolutionAudit).toHaveLength(1);
  });

  it("throws on a drifted record copy whose id still exists (CAS mismatch must be loud)", async () => {
    const record = blockedFolderRecord();
    const harness = makeHarness({
      pluginData: { "easy-sync-v2-mutation-ledger": [record] },
    });
    const state = new StateManager(harness.plugin);
    await state.load();
    const drifted = structuredClone(record);
    (drifted.intent as { createdAt: number }).createdAt = 999;

    await expect(state.settleFolderMutationRecoveryAsObserved({
      expectedRecord: drifted,
    })).rejects.toThrow(/no longer matches/);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.manualMutationResolutionAudit).toHaveLength(0);
  });

  it("refuses non-folder records (fail-closed on the new exit)", async () => {
    const fileRecord: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "stuck-file-op",
        planRevision: 1,
        scope,
        action: "upload",
        path: "Notes/a.md",
        expectedLocal: { exists: true, hash: hashA, size: remoteA.size },
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
      pluginData: { "easy-sync-v2-mutation-ledger": [fileRecord] },
    });
    const state = new StateManager(harness.plugin);
    await state.load();

    await expect(state.settleFolderMutationRecoveryAsObserved({
      expectedRecord: fileRecord,
    })).rejects.toThrow("Only a folder mutation record");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.manualMutationResolutionAudit).toHaveLength(0);
  });
});
