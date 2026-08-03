import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import {
  buildRemoteScopeRecoveryCandidateV2,
} from "../src/sync/remote-scope-recovery-v2";
import type {
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  SyncScope,
} from "../src/sync/types";

const OLD_SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault-old",
  filesRootId: "files-old",
};
const NEW_SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault-new",
  filesRootId: "files-new",
};
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function sourceEnvelope(input: {
  anchors?: Record<string, SyncAnchorV2>;
  folderAnchors?: SyncStateEnvelopeV2["folderAnchors"]["byAnchorId"];
} = {}): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 3,
      commitSeq: 8,
      committedAt: 80,
    },
    scope: OLD_SCOPE,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: OLD_SCOPE.filesRootId,
      cursorRevision: 7,
      deltaLink: "old-delta",
      complete: true,
      itemsById: {},
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: input.anchors ?? {},
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: input.folderAnchors ?? {},
    },
    remoteScopeRecovery: {
      schemaVersion: 1,
      kind: "v2-remote-scope-recovery",
      reason: "committed-scope-unreachable",
      sourceCommitSeq: 7,
      observedScope: NEW_SCOPE,
      observedAt: 81,
    },
  };
}

function file(
  id: string,
  name: string,
  parentId = NEW_SCOPE.filesRootId,
  hash?: string,
  size = 3,
): DriveItem {
  return {
    id,
    name,
    parentReference: { id: parentId, driveId: NEW_SCOPE.driveId },
    file: {
      mimeType: "text/plain",
      hashes: hash ? { sha256Hash: hash } : undefined,
    },
    size,
    eTag: `etag-${id}`,
  };
}

function folder(
  id: string,
  name: string,
  parentId = NEW_SCOPE.filesRootId,
): DriveItem {
  return {
    id,
    name,
    parentReference: { id: parentId, driveId: NEW_SCOPE.driveId },
    folder: {},
    eTag: `etag-${id}`,
  };
}

function local(
  path: string,
  hash: string,
  size = 3,
): LocalFileEntry {
  return {
    path,
    hash,
    size,
    mtime: 1,
    binary: false,
  };
}

function build(input: {
  source?: SyncStateEnvelopeV2;
  files?: LocalFileEntry[];
  folders?: LocalFolderEntry[];
  remote?: DriveItem[];
  verified?: Record<string, string>;
}) {
  return buildRemoteScopeRecoveryCandidateV2({
    sourceEnvelope: input.source ?? sourceEnvelope(),
    observedScope: NEW_SCOPE,
    localScanComplete: true,
    localFolderScanComplete: true,
    localFiles: input.files ?? [],
    localFolders: input.folders ?? [],
    remoteItems: input.remote ?? [],
    remoteScanComplete: true,
    deltaLink: "new-delta",
    verifiedRemoteHashesById: input.verified,
    now: 90,
  });
}

describe("buildRemoteScopeRecoveryCandidateV2", () => {
  it("preserves a historical file anchor only when the same remote id survives", () => {
    const prior: SyncAnchorV2 = {
      anchorId: "anchor:stable",
      remoteId: "stable",
      lastPath: "old.md",
      contentHash: HASH_A,
      size: 3,
      remoteETag: "old-etag",
      confirmedAt: 10,
      confirmedBy: "upload-cas",
    };
    const result = build({
      source: sourceEnvelope({ anchors: { [prior.anchorId]: prior } }),
      files: [local("local-edit.md", HASH_B)],
      remote: [file("stable", "remote-edit.md", undefined, HASH_C)],
    });

    expect(result.status).toBe("ready");
    expect(result.envelope?.anchors.byAnchorId[prior.anchorId]).toEqual(prior);
    expect(result.facts.fileAnchorsPreservedById).toBe(1);
  });

  it("does not inherit an old anchor from path alone", () => {
    const prior: SyncAnchorV2 = {
      anchorId: "anchor:gone",
      remoteId: "gone",
      lastPath: "same.md",
      contentHash: HASH_A,
      size: 3,
      remoteETag: "old-etag",
      confirmedAt: 10,
      confirmedBy: "upload-cas",
    };
    const result = build({
      source: sourceEnvelope({ anchors: { [prior.anchorId]: prior } }),
      files: [local("same.md", HASH_B)],
      remote: [file("replacement", "same.md", undefined, HASH_C)],
    });

    expect(result.status).toBe("ready");
    expect(result.envelope?.anchors.byAnchorId).toEqual({});
    expect(result.facts.fileAnchorsRetired).toBe(1);
  });

  it("rebinds a replaced id only with exact historical content evidence", () => {
    const prior: SyncAnchorV2 = {
      anchorId: "anchor:old",
      remoteId: "old",
      lastPath: "same.md",
      contentHash: HASH_A,
      size: 3,
      remoteETag: "old-etag",
      confirmedAt: 10,
      confirmedBy: "upload-cas",
    };
    const result = build({
      source: sourceEnvelope({ anchors: { [prior.anchorId]: prior } }),
      files: [local("same.md", HASH_B)],
      remote: [file("new", "same.md", undefined, HASH_A)],
    });

    const recovered = result.envelope?.anchors.byAnchorId[prior.anchorId];
    expect(recovered?.remoteId).toBe("new");
    expect(recovered?.remoteIdentityLineage).toEqual([
      expect.objectContaining({
        fromRemoteId: "old",
        toRemoteId: "new",
        contentHash: HASH_A,
      }),
    ]);
    expect(result.facts.fileAnchorsReboundByContent).toBe(1);
  });

  it("creates a fresh common anchor when both live sides prove equal bytes", () => {
    const result = build({
      files: [local("same.md", HASH_B)],
      remote: [file("new", "same.md", undefined, undefined)],
      verified: { new: HASH_B },
    });

    expect(result.status).toBe("ready");
    expect(Object.values(result.envelope!.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: "scope-recovered:new",
        remoteId: "new",
        lastPath: "same.md",
        contentHash: HASH_B,
      }),
    ]);
    expect(result.envelope?.remoteIndex.itemsById.new?.contentHash).toBe(HASH_B);
    expect(result.facts.fileAnchorsCreatedEqual).toBe(1);
  });

  it("refreshes stable folder identity but never inherits a replaced folder by path", () => {
    const result = build({
      source: sourceEnvelope({
        folderAnchors: {
          "folder:stable": {
            anchorId: "folder:stable",
            remoteId: "stable-folder",
            lastPath: "before",
            parentRemoteId: OLD_SCOPE.filesRootId,
            confirmedGeneration: 3,
            confirmedAt: 10,
          },
          "folder:gone": {
            anchorId: "folder:gone",
            remoteId: "gone-folder",
            lastPath: "same",
            parentRemoteId: OLD_SCOPE.filesRootId,
            confirmedGeneration: 3,
            confirmedAt: 10,
          },
        },
      }),
      folders: [{ path: "after" }, { path: "same" }],
      remote: [
        folder("stable-folder", "after"),
        folder("replacement-folder", "same"),
      ],
    });

    expect(result.envelope?.folderAnchors?.byAnchorId["folder:stable"])
      .toEqual(expect.objectContaining({
        remoteId: "stable-folder",
        lastPath: "after",
        parentRemoteId: NEW_SCOPE.filesRootId,
      }));
    expect(result.envelope?.folderAnchors?.byAnchorId["folder:gone"])
      .toBeUndefined();
    expect(Object.values(result.envelope!.folderAnchors!.byAnchorId))
      .toContainEqual(expect.objectContaining({
        anchorId: "scope-recovered-folder:replacement-folder",
        remoteId: "replacement-folder",
        lastPath: "same",
      }));
    expect(result.facts.folderAnchorsRetired).toBe(1);
  });

  it("fails closed on incomplete scans or contradictory hash evidence", () => {
    const incomplete = buildRemoteScopeRecoveryCandidateV2({
      sourceEnvelope: sourceEnvelope(),
      observedScope: NEW_SCOPE,
      localScanComplete: false,
      localFolderScanComplete: true,
      localFiles: [],
      localFolders: [],
      remoteItems: [],
      remoteScanComplete: true,
      deltaLink: null,
    });
    expect(incomplete).toMatchObject({
      status: "aborted",
      reason: "scan-incomplete",
      envelope: null,
    });

    const contradictory = build({
      remote: [file("new", "same.md", undefined, HASH_A)],
      verified: { new: HASH_B },
    });
    expect(contradictory).toMatchObject({
      status: "aborted",
      reason: "remote-hash-evidence-invalid",
      envelope: null,
    });
  });
});
