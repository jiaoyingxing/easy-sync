import type { SyncStateEnvelopeV2 } from "../../src/sync/state-envelope-v2";

export const LARGE_V2_FIXTURE_SCOPE = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};

/**
 * Shared large-state contract used by the production cold-start test and the
 * isolated structured-state POC. Keep this as the single 50k identity fixture
 * so storage comparisons exercise exactly the same envelope.
 */
export function createLargeV2Envelope(
  fileCount: number,
): SyncStateEnvelopeV2 {
  const folderId = "folder-bulk";
  const contentHash = "a".repeat(64);
  const itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"] = {
    [folderId]: {
      id: folderId,
      parentId: LARGE_V2_FIXTURE_SCOPE.filesRootId,
      name: "Bulk",
      kind: "folder",
    },
  };
  const byAnchorId: SyncStateEnvelopeV2["anchors"]["byAnchorId"] = {};
  for (let index = 0; index < fileCount; index += 1) {
    const suffix = String(index).padStart(5, "0");
    const remoteId = `file-${suffix}`;
    const name = `note-${suffix}.md`;
    const path = `Bulk/${name}`;
    const eTag = `etag-${suffix}`;
    itemsById[remoteId] = {
      id: remoteId,
      parentId: folderId,
      name,
      kind: "file",
      size: 1,
      mtime: 1,
      eTag,
      cTag: `ctag-${suffix}`,
      contentHash,
    };
    byAnchorId[`file:${remoteId}`] = {
      anchorId: `file:${remoteId}`,
      remoteId,
      lastPath: path,
      contentHash,
      size: 1,
      remoteETag: eTag,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
  }
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 2,
      commitSeq: 3,
      committedAt: 1,
    },
    scope: { ...LARGE_V2_FIXTURE_SCOPE },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: LARGE_V2_FIXTURE_SCOPE.filesRootId,
      cursorRevision: 1,
      deltaLink: "delta",
      complete: true,
      itemsById,
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId,
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {
        "folder:folder-bulk": {
          anchorId: "folder:folder-bulk",
          remoteId: folderId,
          lastPath: "Bulk",
          parentRemoteId: LARGE_V2_FIXTURE_SCOPE.filesRootId,
          confirmedGeneration: 3,
          confirmedAt: 1,
        },
      },
    },
  };
}
