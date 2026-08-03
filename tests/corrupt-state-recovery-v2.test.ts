import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import type { DriveItem } from "../src/onedrive/types";
import {
  buildCorruptStateRecoveryCandidateV2,
} from "../src/sync/corrupt-state-recovery-v2";
import type {
  StateEnvelopeV2CorruptionEvidence,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type {
  LocalFileEntry,
  SyncScope,
} from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function envelope(): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 3,
      commitSeq: 8,
      committedAt: 80,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 7,
      deltaLink: "old-delta",
      complete: true,
      itemsById: {
        old: {
          id: "old",
          parentId: scope.filesRootId,
          name: "same.md",
          kind: "file",
          size: 3,
          contentHash: hashA,
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        "anchor:old": {
          anchorId: "anchor:old",
          remoteId: "old",
          lastPath: "same.md",
          contentHash: hashA,
          size: 3,
          ancestorHash: hashA,
          confirmedAt: 10,
          confirmedBy: "equal-read",
        },
      },
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {},
    },
  };
}

async function evidence(
  value: SyncStateEnvelopeV2,
  corruption: StateEnvelopeV2CorruptionEvidence["corruption"],
): Promise<StateEnvelopeV2CorruptionEvidence> {
  const rawEnvelope = JSON.stringify(value);
  return {
    version: 1,
    kind: "v2-corrupt-state-evidence",
    scope,
    sourceCommitSeq: value.meta.commitSeq,
    sourceLifecycleEpoch: value.meta.lifecycleEpoch,
    sourceDigest: await sha256Hex(
      new TextEncoder().encode(rawEnvelope).buffer,
    ),
    corruption,
    rawEnvelope,
  };
}

function remote(
  id: string,
  name: string,
  hash?: string,
): DriveItem {
  return {
    id,
    name,
    parentReference: { id: scope.filesRootId, driveId: scope.driveId },
    file: {
      mimeType: "text/plain",
      hashes: hash ? { sha256Hash: hash } : undefined,
    },
    size: 3,
    eTag: `etag-${id}`,
  };
}

function remoteFolder(id: string, name: string): DriveItem {
  return {
    id,
    name,
    parentReference: { id: scope.filesRootId, driveId: scope.driveId },
    folder: {},
    eTag: `etag-${id}`,
  };
}

function local(path: string, hash: string): LocalFileEntry {
  return {
    path,
    hash,
    size: 3,
    mtime: 1,
    binary: false,
  };
}

describe("buildCorruptStateRecoveryCandidateV2", () => {
  it("preserves independently valid anchors by stable id and only keeps proven ancestors", async () => {
    const source = envelope() as SyncStateEnvelopeV2 & {
      futureField?: { keep: boolean };
    };
    source.futureField = { keep: true };
    source.remoteIndex.itemsById.old!.parentId = "missing-parent";
    const result = await buildCorruptStateRecoveryCandidateV2({
      source: await evidence(source, "remote-index"),
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [local("local-edit.md", hashB)],
      localFolders: [],
      remoteItems: [remote("old", "remote-edit.md", hashB)],
      remoteScanComplete: true,
      deltaLink: "new-delta",
      verifiedAncestorHashes: new Set([hashA]),
      now: 90,
    });

    expect(result.status).toBe("ready");
    expect(result.envelope).toMatchObject({
      futureField: { keep: true },
      meta: { lifecycleEpoch: 4, commitSeq: 9 },
      anchors: {
        byAnchorId: {
          "anchor:old": {
            remoteId: "old",
            lastPath: "same.md",
            ancestorHash: hashA,
          },
        },
      },
    });
    expect(result.facts).toMatchObject({
      sourceAnchorsUsable: true,
      fileAnchorsPreservedById: 1,
      ancestorReferencesPreserved: 1,
    });
  });

  it("drops an unverified ancestor reference without discarding the common-state anchor", async () => {
    const source = envelope();
    source.remoteIndex.itemsById.old!.parentId = "missing-parent";
    const result = await buildCorruptStateRecoveryCandidateV2({
      source: await evidence(source, "remote-index"),
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [],
      localFolders: [],
      remoteItems: [remote("old", "same.md", hashB)],
      remoteScanComplete: true,
      deltaLink: "new-delta",
      now: 90,
    });

    expect(result.envelope?.anchors.byAnchorId["anchor:old"])
      .not.toHaveProperty("ancestorHash");
    expect(result.facts.ancestorReferencesDropped).toBe(1);
  });

  it("discards damaged anchors and creates only fresh exact same-path common state", async () => {
    const source = envelope();
    source.anchors.byAnchorId["anchor:old"]!.anchorId = "wrong";
    const result = await buildCorruptStateRecoveryCandidateV2({
      source: await evidence(source, "anchors"),
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [
        local("same.md", hashB),
        local("different.md", hashA),
      ],
      localFolders: [],
      remoteItems: [
        remote("replacement", "same.md", hashB),
        remote("different", "different.md", hashB),
      ],
      remoteScanComplete: true,
      deltaLink: "new-delta",
      now: 90,
    });

    expect(result.status).toBe("ready");
    expect(result.facts.sourceAnchorsUsable).toBe(false);
    expect(Object.values(result.envelope!.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: "corrupt-recovered:replacement",
        remoteId: "replacement",
        lastPath: "same.md",
        contentHash: hashB,
      }),
    ]);
  });

  it("rebuilds folders from current shared topology instead of inheriting a damaged folder identity", async () => {
    const source = envelope();
    source.folderAnchors.byAnchorId = {
      "folder:old": {
        anchorId: "wrong-folder-anchor",
        remoteId: "old-folder",
        lastPath: "same",
        parentRemoteId: scope.filesRootId,
        confirmedGeneration: 8,
        confirmedAt: 10,
      },
    };
    const result = await buildCorruptStateRecoveryCandidateV2({
      source: await evidence(source, "anchors"),
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [],
      localFolders: [{ path: "same" }],
      remoteItems: [remoteFolder("replacement-folder", "same")],
      remoteScanComplete: true,
      deltaLink: "new-delta",
      now: 90,
    });

    expect(result.status).toBe("ready");
    expect(Object.values(result.envelope!.folderAnchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: "corrupt-recovered-folder:replacement-folder",
        remoteId: "replacement-folder",
        lastPath: "same",
      }),
    ]);
    expect(result.envelope?.folderAnchors.byAnchorId)
      .not.toHaveProperty("folder:old");
  });

  it("requires exact source bytes, complete scans, and valid downloaded hash evidence", async () => {
    const source = envelope();
    source.anchors.byAnchorId["anchor:old"]!.anchorId = "wrong";
    const validEvidence = await evidence(source, "anchors");

    await expect(buildCorruptStateRecoveryCandidateV2({
      source: { ...validEvidence, sourceDigest: hashA },
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [],
      localFolders: [],
      remoteItems: [],
      remoteScanComplete: true,
      deltaLink: null,
    })).resolves.toMatchObject({
      status: "aborted",
      reason: "source-digest-mismatch",
    });
    await expect(buildCorruptStateRecoveryCandidateV2({
      source: validEvidence,
      localScanComplete: false,
      localFolderScanComplete: true,
      localFiles: [],
      localFolders: [],
      remoteItems: [],
      remoteScanComplete: true,
      deltaLink: null,
    })).resolves.toMatchObject({
      status: "aborted",
      reason: "scan-incomplete",
    });
    await expect(buildCorruptStateRecoveryCandidateV2({
      source: validEvidence,
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: [local("same.md", hashB)],
      localFolders: [],
      remoteItems: [remote("replacement", "same.md")],
      remoteScanComplete: true,
      deltaLink: null,
      verifiedRemoteHashesById: { replacement: "not-a-hash" },
    })).resolves.toMatchObject({
      status: "aborted",
      reason: "remote-hash-evidence-invalid",
    });
  });
});
