import { describe, expect, it } from "vitest";
import {
  buildStaleIdentityResolutionSnapshotV1,
  retireReviewedStaleIdentityV2,
} from "../src/sync/stale-identity-resolution";
import { buildCanonicalPlanCandidateV2 } from "../src/sync/canonical-plan-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  SyncActionType,
  type LocalFileEntry,
  type LocalFolderEntry,
} from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hash = "a".repeat(64);

function baseEnvelope(): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 2,
      commitSeq: 7,
      committedAt: 7,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 3,
      deltaLink: "delta-3",
      complete: true,
      itemsById: {},
    },
    anchors: { schemaVersion: 2, byAnchorId: {} },
    folderAnchors: { schemaVersion: 2, byAnchorId: {} },
  };
}

function localFile(path: string): LocalFileEntry {
  return {
    path,
    hash,
    size: 4,
    mtime: 10,
    binary: false,
  };
}

function facts(
  envelope: SyncStateEnvelopeV2,
  localFiles: readonly LocalFileEntry[],
  localFolders: readonly LocalFolderEntry[] = [],
) {
  return {
    envelope,
    localFiles,
    localFolders,
    localFolderScanComplete: true,
    skippedLarge: [],
    configDir: ".obsidian",
    automaticDeleteLocalFiles: false,
  };
}

describe("reviewed stale identity retirement", () => {
  it("retires only the ambiguous file anchor and preserves both current sides", () => {
    const envelope = baseEnvelope();
    envelope.remoteIndex.itemsById.replacement = {
      id: "replacement",
      parentId: scope.filesRootId,
      name: "old.md",
      kind: "file",
      size: 9,
      eTag: "replacement-etag",
      contentHash: "b".repeat(64),
    };
    envelope.anchors.byAnchorId["file:old"] = {
      anchorId: "file:old",
      remoteId: "old-remote-id",
      lastPath: "old.md",
      contentHash: hash,
      size: 4,
      remoteETag: "old-etag",
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };

    const reviewed = buildStaleIdentityResolutionSnapshotV1(
      "old.md",
      "identity-replacement-ambiguous",
      facts(envelope, [localFile("moved.md")]),
    );
    expect(reviewed).toMatchObject({
      kind: "file-replacement",
      path: "old.md",
      relatedPaths: ["moved.md"],
      fileAnchors: [{ anchorId: "file:old", remoteId: "old-remote-id" }],
      folderAnchors: [],
      primaryRemote: { remoteId: "old-remote-id", status: "missing" },
      pathFacts: [
        { path: "moved.md", remote: null },
        { path: "old.md", remote: { remoteId: "replacement" } },
      ],
    });

    const retired = retireReviewedStaleIdentityV2(
      envelope,
      reviewed!,
      20,
    );
    expect(retired).toMatchObject({
      status: "accepted",
      retiredFileAnchors: 1,
      retiredFolderAnchors: 0,
    });
    if (retired.status !== "accepted") throw new Error("expected acceptance");
    expect(retired.envelope.meta).toMatchObject({ commitSeq: 8, committedAt: 20 });
    expect(retired.envelope.anchors.byAnchorId).toEqual({});
    expect(retired.envelope.remoteIndex.itemsById.replacement).toEqual(
      envelope.remoteIndex.itemsById.replacement,
    );
    const replanned = buildCanonicalPlanCandidateV2(
      facts(retired.envelope, [localFile("moved.md")]),
    );
    expect(replanned.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: SyncActionType.Upload, path: "moved.md" }),
      expect.objectContaining({ type: SyncActionType.Download, path: "old.md" }),
    ]));
    expect(replanned.items).not.toContainEqual(expect.objectContaining({
      reason: "reason.identityReplacement.ambiguous",
    }));
  });

  it("rejects a reviewed file retirement when the old remote identity reappears", () => {
    const envelope = baseEnvelope();
    envelope.remoteIndex.itemsById.replacement = {
      id: "replacement",
      parentId: scope.filesRootId,
      name: "old.md",
      kind: "file",
      size: 9,
      eTag: "replacement-etag",
    };
    envelope.anchors.byAnchorId["file:old"] = {
      anchorId: "file:old",
      remoteId: "old-remote-id",
      lastPath: "old.md",
      contentHash: hash,
      size: 4,
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    const reviewed = buildStaleIdentityResolutionSnapshotV1(
      "old.md",
      "identity-replacement-ambiguous",
      facts(envelope, [localFile("moved.md")]),
    )!;
    const changed = structuredClone(envelope);
    changed.remoteIndex.itemsById["old-remote-id"] = {
      id: "old-remote-id",
      parentId: scope.filesRootId,
      name: "returned.md",
      kind: "file",
      size: 4,
      eTag: "returned-etag",
    };

    expect(retireReviewedStaleIdentityV2(changed, reviewed, 20)).toEqual({
      status: "rejected",
      reason: "remote-facts-changed",
      envelope: changed,
    });
  });

  it("retires one missing remote folder lineage without touching local or remote facts", () => {
    const envelope = baseEnvelope();
    envelope.folderAnchors!.byAnchorId["folder:old-root"] = {
      anchorId: "folder:old-root",
      remoteId: "old-root",
      lastPath: "Resources/Politics",
      parentRemoteId: scope.filesRootId,
      confirmedGeneration: 2,
      confirmedAt: 2,
    };
    envelope.folderAnchors!.byAnchorId["folder:old-child"] = {
      anchorId: "folder:old-child",
      remoteId: "old-child",
      lastPath: "Resources/Politics/Attachments",
      parentRemoteId: "old-root",
      confirmedGeneration: 2,
      confirmedAt: 2,
    };
    envelope.anchors.byAnchorId["file:old-note"] = {
      anchorId: "file:old-note",
      remoteId: "old-note",
      lastPath: "Resources/Politics/Attachments/note.md",
      contentHash: hash,
      size: 4,
      confirmedAt: 2,
      confirmedBy: "equal-read",
    };
    const localFolders: LocalFolderEntry[] = [
      { path: "Knowledge" },
      { path: "Knowledge/Politics" },
      { path: "Knowledge/Politics/Attachments" },
    ];
    const localFiles = [localFile("Knowledge/Politics/Attachments/note.md")];

    const reviewed = buildStaleIdentityResolutionSnapshotV1(
      "Resources/Politics",
      "anchored-folder-missing-remote",
      facts(envelope, localFiles, localFolders),
    );
    expect(reviewed).toMatchObject({
      kind: "folder-missing-remote",
      path: "Resources/Politics",
      relatedPaths: ["Knowledge/Politics"],
      fileAnchors: [{ anchorId: "file:old-note", remoteId: "old-note" }],
      folderAnchors: [
        { anchorId: "folder:old-child", remoteId: "old-child" },
        { anchorId: "folder:old-root", remoteId: "old-root" },
      ],
      primaryRemote: { remoteId: "old-root", status: "missing" },
    });

    const retired = retireReviewedStaleIdentityV2(envelope, reviewed!, 20);
    expect(retired).toMatchObject({
      status: "accepted",
      retiredFileAnchors: 1,
      retiredFolderAnchors: 2,
    });
    if (retired.status !== "accepted") throw new Error("expected acceptance");
    expect(retired.envelope.anchors.byAnchorId).toEqual({});
    expect(retired.envelope.folderAnchors!.byAnchorId).toEqual({});
    expect(retired.envelope.remoteIndex).toEqual(envelope.remoteIndex);
    const replanned = buildCanonicalPlanCandidateV2(
      facts(retired.envelope, localFiles, localFolders),
    );
    expect(replanned.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.CreateRemoteFolder,
      path: "Knowledge/Politics",
    }));
    expect(replanned.items).not.toContainEqual(expect.objectContaining({
      reason: "reason.folder.anchored-folder-missing-remote",
    }));
  });

  it("refuses to retire a folder lineage with a still-reachable descendant identity", () => {
    const envelope = baseEnvelope();
    envelope.folderAnchors!.byAnchorId["folder:old-root"] = {
      anchorId: "folder:old-root",
      remoteId: "old-root",
      lastPath: "Old",
      parentRemoteId: scope.filesRootId,
      confirmedGeneration: 2,
      confirmedAt: 2,
    };
    envelope.anchors.byAnchorId["file:child"] = {
      anchorId: "file:child",
      remoteId: "child",
      lastPath: "Old/a.md",
      contentHash: hash,
      size: 4,
      confirmedAt: 2,
      confirmedBy: "equal-read",
    };
    envelope.remoteIndex.itemsById.child = {
      id: "child",
      parentId: scope.filesRootId,
      name: "elsewhere.md",
      kind: "file",
      size: 4,
      eTag: "child-etag",
    };

    expect(buildStaleIdentityResolutionSnapshotV1(
      "Old",
      "anchored-folder-missing-remote",
      facts(
        envelope,
        [localFile("New/a.md")],
        [{ path: "New" }],
      ),
    )).toBeNull();
  });
});
