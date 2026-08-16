import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { planFolderStateV2 } from "../src/sync/folder-state-v2";
import {
  acceptReviewedFolderSubtreeRestoreV2,
  buildEmptyFolderResolutionSnapshotV1,
  buildFolderLocationResolutionSnapshotV1,
  buildFolderSubtreeReviewSnapshotV1,
} from "../src/sync/empty-folder-resolution";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import {
  shouldPauseCanonicalPlanForReviewV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
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
const hashA = "a".repeat(64);

interface FolderSpec {
  id: string;
  name: string;
  parentId?: string;
  cTag?: string | null;
}

interface FileSpec {
  id: string;
  name: string;
  parentId: string;
  hash?: string;
  size?: number;
}

function envelope(input: {
  folders?: FolderSpec[];
  files?: FileSpec[];
  folderAnchors?: FolderAnchorV2[] | null;
  fileAnchors?: SyncAnchorV2[];
  commitSeq?: number;
}): SyncStateEnvelopeV2 {
  const remoteItems: DriveItem[] = [
    ...(input.folders ?? []).map((folder): DriveItem => ({
      id: folder.id,
      name: folder.name,
      parentReference: { id: folder.parentId ?? scope.filesRootId },
      folder: {},
      eTag: `etag-${folder.id}`,
      cTag: folder.cTag === null
        ? undefined
        : folder.cTag ?? `ctag-${folder.id}`,
    })),
    ...(input.files ?? []).map((file): DriveItem => ({
      id: file.id,
      name: file.name,
      parentReference: { id: file.parentId },
      file: { hashes: { sha256Hash: file.hash ?? hashA } },
      size: file.size ?? 10,
      eTag: `etag-${file.id}`,
      cTag: `ctag-${file.id}`,
    })),
  ];
  const commitSeq = input.commitSeq ?? 1;
  const result: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 1,
      commitSeq,
      committedAt: 1,
    },
    scope,
    remoteIndex: buildRemoteIndexV2(remoteItems, scope.filesRootId, null, 1).index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.fileAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    },
  };
  if (input.folderAnchors !== null) {
    result.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.folderAnchors ?? []).map((anchor) => [anchor.anchorId, anchor]),
      ),
    };
  }
  return result;
}

function folderAnchor(
  remoteId: string,
  lastPath: string,
  parentRemoteId = scope.filesRootId,
): FolderAnchorV2 {
  return {
    anchorId: `folder:${remoteId}`,
    remoteId,
    lastPath,
    parentRemoteId,
    remoteETag: `etag-${remoteId}`,
    confirmedGeneration: 1,
    confirmedAt: 1,
  };
}

function fileAnchor(
  remoteId: string,
  lastPath: string,
  hash = hashA,
  size = 10,
): SyncAnchorV2 {
  return {
    anchorId: `file:${remoteId}`,
    remoteId,
    lastPath,
    contentHash: hash,
    size,
    remoteETag: `etag-${remoteId}`,
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
}

function localFile(path: string, hash = hashA, size = 10): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

describe("V2 folder anchors and pure planner", () => {
  it("rejects planning until a pre-S5 envelope has an initialized anchor set", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: null,
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });

    expect(report).toMatchObject({
      status: "rejected",
      rejectionReason: "folder-anchors-uninitialized",
      items: [],
      mutations: [],
    });
  });

  it("treats unanchored one-sided folders as creates, never deletes", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [
          { id: "shared", name: "Shared" },
          { id: "remote-only", name: "RemoteOnly" },
        ],
        folderAnchors: [folderAnchor("shared", "Shared")],
      }),
      localFiles: [],
      localFolders: localFolders("Shared", "LocalOnly"),
      localFolderScanComplete: true,
    });

    expect(report.items.map((item) => [item.type, item.path])).toEqual([
      ["create-remote", "LocalOnly"],
      ["create-local", "RemoteOnly"],
    ]);
    expect(report.counts).toMatchObject({ createLocal: 1, createRemote: 1, conflicts: 0 });
    expect(report.mutations).toEqual([]);
  });

  it("plans one local move when a stable remote folder id changes path", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Archive" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-local",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
      impact: { files: 0, folders: 1, bytes: 0 },
    })]);
    expect(report.reviewImpact).toEqual({ actions: 1, files: 0, folders: 1, bytes: 0 });
  });

  it("plans the exact remote folder move before reconciling a changed remote child", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Archive" }],
        files: [{
          id: "file-a",
          name: "a.md",
          parentId: "notes",
          hash: "b".repeat(64),
        }],
        folderAnchors: [folderAnchor("notes", "Notes")],
        fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
      }),
      localFiles: [localFile("Notes/a.md")],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-local",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
    })]);
    expect(report.counts).toMatchObject({
      moveLocal: 1,
      conflicts: 0,
    });
  });

  it("does not let a remote folder move overwrite a concurrent local child edit", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Archive" }],
        files: [{
          id: "file-a",
          name: "a.md",
          parentId: "notes",
          hash: "b".repeat(64),
        }],
        folderAnchors: [folderAnchor("notes", "Notes")],
        fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
      }),
      localFiles: [localFile("Notes/a.md", "c".repeat(64))],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-subtree-changed",
      remoteId: "notes",
    })]);
    expect(report.counts.moveLocal).toBe(0);
  });

  it("infers one remote move only from a unique unchanged anchored file subtree", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
        fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
      }),
      localFiles: [localFile("Archive/a.md")],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
      impact: { files: 1, folders: 1, bytes: 10 },
    })]);
  });

  it("turns simultaneous local and remote moves into one grouped conflict", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Cloud" }],
        files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
        fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
      }),
      localFiles: [localFile("Archive/a.md")],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "both-sides-moved",
      remoteId: "notes",
    })]);
  });

  it("projects one exact root-location choice when both sides moved", () => {
    const current = envelope({
      folders: [{ id: "notes", name: "Cloud" }],
      files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
      fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
    });

    const reviewed = buildFolderLocationResolutionSnapshotV1("Notes", {
      envelope: current,
      localFiles: [localFile("Archive/a.md")],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(reviewed).toMatchObject({
      version: 1,
      path: "Notes",
      remoteId: "notes",
      remoteETag: "etag-notes",
      remoteSourceParentId: scope.filesRootId,
      localTargetParentId: scope.filesRootId,
      localTargetParentPath: "",
      localPath: "Archive",
      remotePath: "Cloud",
    });
  });

  it("keeps occupied targets, scope crossings and incomplete scans out of root choice", () => {
    const current = envelope({
      folders: [
        { id: "notes", name: "Cloud" },
        { id: "occupied", name: "Archive" },
      ],
      files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
      fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
    });
    const facts = {
      envelope: current,
      localFiles: [localFile("Archive/a.md")],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    };

    expect(buildFolderLocationResolutionSnapshotV1("Notes", facts)).toBeNull();
    const unoccupied = envelope({
      folders: [{ id: "notes", name: "Cloud" }],
      files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
      fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
    });
    expect(buildFolderLocationResolutionSnapshotV1("Notes", {
      ...facts,
      envelope: unoccupied,
      localFolderScanComplete: false,
    })).toBeNull();
    expect(buildFolderLocationResolutionSnapshotV1("Notes", {
      ...facts,
      envelope: unoccupied,
      includeFolderPath: (path) => path !== "Archive",
    })).toBeNull();
  });

  it("plans an exact folder move before a changed carried child", () => {
    const current = envelope({
      folders: [{ id: "notes", name: "Notes" }],
      files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
      fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [localFile("Archive/a.md", "b".repeat(64))],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "notes",
        fromPath: "Notes",
        toPath: "Archive",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      path: "Archive",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
    })]);
    expect(report.counts).toMatchObject({
      moveRemote: 1,
      conflicts: 0,
    });
  });

  it("plans an exact folder move before reconciling a changed carried child set", () => {
    const current = envelope({
      folders: [{ id: "notes", name: "Notes" }],
      files: [{ id: "file-a", name: "a.md", parentId: "notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
      fileAnchors: [fileAnchor("file-a", "Notes/a.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [
        localFile("Archive/a.md"),
        localFile("Archive/new.md"),
      ],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "notes",
        fromPath: "Notes",
        toPath: "Archive",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      path: "Archive",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
    })]);
    expect(report.counts).toMatchObject({
      moveRemote: 1,
      conflicts: 0,
    });
  });

  it("allows an explicitly renamed folder to receive uniquely anchored unchanged files", () => {
    const current = envelope({
      folders: [{ id: "text", name: "text" }],
      files: [{ id: "report", name: "report.md", parentId: scope.filesRootId }],
      folderAnchors: [folderAnchor("text", "text")],
      fileAnchors: [fileAnchor("report", "report.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [localFile("text-renamed/report.md")],
      localFolders: localFolders("text-renamed"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "text",
        fromPath: "text",
        toPath: "text-renamed",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "text",
      targetPath: "text-renamed",
      remoteId: "text",
    })]);
    expect(report.counts).toMatchObject({
      moveRemote: 1,
      conflicts: 0,
    });
  });

  it("allows incoming anchored files to target an existing descendant of the renamed folder", () => {
    const current = envelope({
      folders: [
        { id: "text", name: "text" },
        { id: "nested", name: "nested", parentId: "text" },
      ],
      files: [{ id: "report", name: "report.md", parentId: scope.filesRootId }],
      folderAnchors: [
        folderAnchor("text", "text"),
        folderAnchor("nested", "text/nested", "text"),
      ],
      fileAnchors: [fileAnchor("report", "report.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [localFile("text-renamed/nested/report.md")],
      localFolders: localFolders("text-renamed", "text-renamed/nested"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "text",
        fromPath: "text",
        toPath: "text-renamed",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "text",
      targetPath: "text-renamed",
      remoteId: "text",
    })]);
    expect(report.counts).toMatchObject({
      moveRemote: 1,
      conflicts: 0,
    });
  });

  it("keeps an exact folder move independent from a changed incoming file", () => {
    const current = envelope({
      folders: [{ id: "text", name: "text" }],
      files: [{ id: "report", name: "report.md", parentId: scope.filesRootId }],
      folderAnchors: [folderAnchor("text", "text")],
      fileAnchors: [fileAnchor("report", "report.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [localFile("text-renamed/report.md", "b".repeat(64))],
      localFolders: localFolders("text-renamed"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "text",
        fromPath: "text",
        toPath: "text-renamed",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "text",
      targetPath: "text-renamed",
      remoteId: "text",
    })]);
  });

  it("keeps an exact folder move independent from a copied descendant", () => {
    const current = envelope({
      folders: [{ id: "text", name: "text" }],
      files: [{ id: "report", name: "report.md", parentId: scope.filesRootId }],
      folderAnchors: [folderAnchor("text", "text")],
      fileAnchors: [fileAnchor("report", "report.md")],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [
        localFile("report.md"),
        localFile("text-renamed/report.md"),
      ],
      localFolders: localFolders("text-renamed"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "text",
        fromPath: "text",
        toPath: "text-renamed",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "text",
      targetPath: "text-renamed",
      remoteId: "text",
    })]);
  });

  it("does not infer a deleted synced copy into another anchored folder", () => {
    const current = envelope({
      folders: [
        { id: "notes", name: "Notes" },
        { id: "notes-copy", name: "Notes - Copy" },
      ],
      files: [
        { id: "report", name: "report.md", parentId: "notes" },
        { id: "report-copy", name: "report.md", parentId: "notes-copy" },
      ],
      folderAnchors: [
        folderAnchor("notes", "Notes"),
        folderAnchor("notes-copy", "Notes - Copy"),
      ],
      fileAnchors: [
        fileAnchor("report", "Notes/report.md"),
        fileAnchor("report-copy", "Notes - Copy/report.md"),
      ],
    });
    const report = planFolderStateV2({
      envelope: current,
      localFiles: [localFile("Notes/report.md")],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "delete-remote",
      path: "Notes - Copy",
      remoteId: "notes-copy",
    })]);
    expect(report.items).not.toContainEqual(expect.objectContaining({
      remoteId: "notes",
    }));
  });

  it("fails closed on target occupancy, scope crossing and missing destination parents", () => {
    const occupied = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Archive" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Notes", "Archive"),
      localFolderScanComplete: true,
    });
    expect(occupied.items).toContainEqual(expect.objectContaining({
      type: "conflict",
      reason: "target-occupied",
    }));

    const scopeCrossing = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Archive" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
      includeFolderPath: (path) => path !== "Archive",
    });
    expect(scopeCrossing.items).toContainEqual(expect.objectContaining({
      type: "conflict",
      reason: "scope-crossing",
    }));

    const missingParent = planFolderStateV2({
      envelope: envelope({
        folders: [
          { id: "parent", name: "Parent" },
          { id: "notes", name: "Notes", parentId: "parent" },
        ],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });
    expect(missingParent.items).toContainEqual(expect.objectContaining({
      type: "conflict",
      reason: "parent-chain-incomplete",
    }));
  });

  it("does not guess the identity of an empty local rename", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "anchored-folder-missing-local",
    })]);
  });

  it("offers explicit resolution only for a fully observed empty-folder ambiguity", () => {
    const current = envelope({
      folders: [{ id: "notes", name: "Notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
    });
    const snapshot = buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(snapshot).toMatchObject({
      version: 1,
      path: "Notes",
      remoteId: "notes",
      remoteETag: "etag-notes",
      remoteCTag: "ctag-notes",
      parentRemoteId: scope.filesRootId,
      candidatePaths: ["Archive"],
    });
  });

  it("projects nested missing-local folders as one complete remote subtree review", () => {
    const current = envelope({
      folders: [
        { id: "issues", name: "Issues" },
        { id: "cad", name: "CAD", parentId: "issues" },
      ],
      files: [{
        id: "drawing",
        name: "drawing.md",
        parentId: "cad",
        hash: "b".repeat(64),
        size: 42,
      }],
      folderAnchors: [
        folderAnchor("issues", "Issues"),
        folderAnchor("cad", "Issues/CAD", "issues"),
      ],
    });

    const fromRoot = buildFolderSubtreeReviewSnapshotV1("Issues", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });
    const fromChild = buildFolderSubtreeReviewSnapshotV1("Issues/CAD", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(fromRoot).toMatchObject({
      version: 1,
      path: "Issues",
      issuePaths: ["Issues", "Issues/CAD"],
      members: [
        { path: "Issues", kind: "folder", remoteId: "issues" },
        { path: "Issues/CAD", kind: "folder", remoteId: "cad" },
        {
          path: "Issues/CAD/drawing.md",
          kind: "file",
          remoteId: "drawing",
          size: 42,
          contentHash: "b".repeat(64),
        },
      ],
    });
    expect(fromChild).toEqual(fromRoot);
  });

  it("retires only the reviewed subtree anchors so ordinary planning restores cloud truth", () => {
    const current = envelope({
      folders: [
        { id: "issues", name: "Issues" },
        { id: "cad", name: "CAD", parentId: "issues" },
        { id: "archive", name: "Archive" },
      ],
      files: [{
        id: "drawing",
        name: "drawing.md",
        parentId: "cad",
        hash: "b".repeat(64),
        size: 42,
      }],
      folderAnchors: [
        folderAnchor("issues", "Issues"),
        folderAnchor("cad", "Issues/CAD", "issues"),
        folderAnchor("archive", "Archive"),
      ],
      fileAnchors: [
        fileAnchor("drawing", "Issues/CAD/drawing.md", "b".repeat(64), 42),
      ],
    });
    const reviewed = buildFolderSubtreeReviewSnapshotV1("Issues", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Archive", "Other"),
      localFolderScanComplete: true,
    });
    expect(reviewed).not.toBeNull();

    const accepted = acceptReviewedFolderSubtreeRestoreV2(
      current,
      reviewed!,
      2,
    );
    expect(accepted).toMatchObject({
      status: "accepted",
      retiredFileAnchors: 1,
      retiredFolderAnchors: 2,
    });
    if (accepted.status !== "accepted") return;
    expect(Object.values(accepted.envelope.anchors.byAnchorId)).toEqual([]);
    expect(Object.values(accepted.envelope.folderAnchors!.byAnchorId))
      .toEqual([expect.objectContaining({ lastPath: "Archive" })]);

    const plan = planFolderStateV2({
      envelope: accepted.envelope,
      localFiles: [],
      localFolders: localFolders("Archive", "Other"),
      localFolderScanComplete: true,
    });
    expect(plan).toMatchObject({
      status: "planned",
      items: expect.arrayContaining([
        expect.objectContaining({ type: "create-local", path: "Issues" }),
        expect.objectContaining({ type: "create-local", path: "Issues/CAD" }),
      ]),
    });
  });

  it("refuses subtree review when local or scope facts are incomplete", () => {
    const current = envelope({
      folders: [
        { id: "issues", name: "Issues" },
        { id: "cad", name: "CAD", parentId: "issues" },
      ],
      files: [{ id: "drawing", name: "drawing.md", parentId: "cad" }],
      folderAnchors: [
        folderAnchor("issues", "Issues"),
        folderAnchor("cad", "Issues/CAD", "issues"),
      ],
    });
    const facts = {
      envelope: current,
      localFiles: [] as LocalFileEntry[],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    };

    expect(buildFolderSubtreeReviewSnapshotV1("Issues", {
      ...facts,
      localFolderScanComplete: false,
    })).toBeNull();
    expect(buildFolderSubtreeReviewSnapshotV1("Issues", {
      ...facts,
      localFiles: [{
        path: "Issues/CAD/local.md",
        size: 1,
        mtime: 1,
        hash: hashA,
      }],
    })).toBeNull();
    expect(buildFolderSubtreeReviewSnapshotV1("Issues", {
      ...facts,
      includeFilePath: (path) => path !== "Issues/CAD/drawing.md",
    })).toBeNull();
  });

  it("keeps incomplete, non-empty, nested-remote and moved-remote cases fail closed", () => {
    const empty = envelope({
      folders: [{ id: "notes", name: "Notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
    });
    expect(buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: empty,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: false,
    })).toBeNull();
    expect(buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: empty,
      localFiles: [localFile("Archive/a.md")],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    })).toBeNull();
    expect(buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: empty,
      localFiles: [],
      localFolders: localFolders("Archive", "Other"),
      localFolderScanComplete: true,
    })).toBeNull();

    const nestedRemote = envelope({
      folders: [
        { id: "notes", name: "Notes" },
        { id: "child", name: "Child", parentId: "notes" },
      ],
      folderAnchors: [
        folderAnchor("notes", "Notes"),
        folderAnchor("child", "Notes/Child", "notes"),
      ],
    });
    expect(buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: nestedRemote,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    })).toBeNull();

    const movedRemote = envelope({
      folders: [{ id: "notes", name: "Cloud" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
    });
    expect(buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: movedRemote,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    })).toBeNull();
  });

  it("binds the review revision to the exact state and candidate set", () => {
    const current = envelope({
      folders: [{ id: "notes", name: "Notes" }],
      folderAnchors: [folderAnchor("notes", "Notes")],
    });
    const first = buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });
    const changedCandidates = buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: current,
      localFiles: [],
      localFolders: localFolders("Other"),
      localFolderScanComplete: true,
    });
    const changedEnvelope = structuredClone(current);
    changedEnvelope.meta.commitSeq++;
    changedEnvelope.remoteIndex.itemsById.notes.eTag = "etag-notes-new";
    const changedRemote = buildEmptyFolderResolutionSnapshotV1("Notes", {
      envelope: changedEnvelope,
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
    });

    expect(first).not.toBeNull();
    expect(changedCandidates).not.toBeNull();
    expect(changedRemote).not.toBeNull();
    expect(first!.revision).not.toBe(changedCandidates!.revision);
    expect(first!.revision).not.toBe(changedRemote!.revision);
  });

  it("never turns a case-only folder spelling change into a delete", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("notes"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-rename-evidence-conflict",
    })]);
    expect(report.items.some((item) => item.type.startsWith("delete-"))).toBe(false);
  });

  it("treats canonically equivalent Unicode folder names as the same identity", () => {
    const composed = "Café";
    const decomposed = "Cafe\u0301";
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "cafe", name: composed }],
        folderAnchors: [folderAnchor("cafe", composed)],
      }),
      localFiles: [],
      localFolders: localFolders(decomposed),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([]);
  });

  it("uses a scope-bound Obsidian folder rename hint to move an empty folder identity", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Archive"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "notes",
        fromPath: "Notes",
        toPath: "Archive",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
    })]);
  });

  it("projects a parent rename hint through empty descendants and keeps one top-level move", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [
          { id: "notes", name: "Notes" },
          { id: "child", name: "Child", parentId: "notes" },
        ],
        folderAnchors: [
          folderAnchor("notes", "Notes"),
          folderAnchor("child", "Notes/Child", "notes"),
        ],
      }),
      localFiles: [],
      localFolders: localFolders("Archive", "Archive/Child"),
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "notes",
        fromPath: "Notes",
        toPath: "Archive",
        observedAt: 10,
      }],
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "Notes",
      targetPath: "Archive",
      remoteId: "notes",
      impact: { files: 0, folders: 2, bytes: 0 },
    })]);
  });

  it("turns a rename out of this device scope into a conflict instead of a delete", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      // The device scanner omits the excluded destination folder.
      localFolders: [],
      localFolderScanComplete: true,
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "notes",
        fromPath: "Notes",
        toPath: "Private/Notes",
        observedAt: 10,
      }],
      includeFolderPath: (path) => !path.startsWith("Private"),
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "scope-crossing",
    })]);
    expect(report.items.some((item) => item.type.startsWith("delete-"))).toBe(false);
  });

  it("plans only anchored one-sided folder deletions", () => {
    const localDelete = planFolderStateV2({
      envelope: envelope({
        folders: [],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
    });
    expect(localDelete.items).toEqual([expect.objectContaining({
      type: "delete-local",
      path: "Notes",
      remoteId: "notes",
    })]);

    const remoteDelete = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: [],
      localFolderScanComplete: true,
    });
    expect(remoteDelete.items).toEqual([expect.objectContaining({
      type: "delete-remote",
      path: "Notes",
      remoteId: "notes",
    })]);
  });

  it("keeps an excluded folder fail-closed unless the caller marks it preserved", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: [],
      localFolderScanComplete: true,
      includeFolderPath: (path) => path !== "Notes",
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "scope-crossing",
    })]);
    expect(report.counts.deleteRemote).toBe(0);
  });

  it("keeps an explicitly preserved remote-only folder outside ordinary scope conflicts", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
        folderAnchors: [folderAnchor("notes", "Notes")],
      }),
      localFiles: [],
      localFolders: [],
      localFolderScanComplete: true,
      includeFolderPath: (path) => path !== "Notes",
      preserveFolderPath: (path) => path === "Notes",
    });

    expect(report.items).toEqual([]);
    expect(report.counts).toEqual({
      createLocal: 0,
      createRemote: 0,
      moveLocal: 0,
      moveRemote: 0,
      deleteLocal: 0,
      deleteRemote: 0,
      conflicts: 0,
    });
  });

  it("keeps a preserved remote folder and its residual local shell outside unanchored-folder conflicts", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "notes", name: "Notes" }],
      }),
      localFiles: [],
      localFolders: localFolders("Notes"),
      localFolderScanComplete: true,
      preserveFolderPath: (path) => path === "Notes",
    });

    expect(report.items).toEqual([]);
    expect(report.counts).toEqual({
      createLocal: 0,
      createRemote: 0,
      moveLocal: 0,
      moveRemote: 0,
      deleteLocal: 0,
      deleteRemote: 0,
      conflicts: 0,
    });
  });

  it("collapses a coherent nested remote move into one top-level action", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [
          { id: "notes", name: "Archive" },
          { id: "child", name: "Child", parentId: "notes" },
        ],
        folderAnchors: [
          folderAnchor("notes", "Notes"),
          folderAnchor("child", "Notes/Child", "notes"),
        ],
      }),
      localFiles: [],
      localFolders: localFolders("Notes", "Notes/Child"),
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "move-local",
      sourcePath: "Notes",
      targetPath: "Archive",
      impact: { files: 0, folders: 2, bytes: 0 },
    })]);
  });

  it("reports file/folder type collisions as conflicts", () => {
    const report = planFolderStateV2({
      envelope: envelope({
        folders: [{ id: "folder", name: "Collision" }],
        folderAnchors: [],
      }),
      localFiles: [localFile("Collision")],
      localFolders: [],
      localFolderScanComplete: true,
    });

    expect(report.items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Collision",
      reason: "type-conflict",
    })]);
  });

  it("uses grouped subtree impact in the existing bulk-change review gate", () => {
    const items = [{
        type: SyncActionType.MoveRemoteFolder,
        path: "Archive",
        renameFrom: "Notes",
        reviewImpactCount: 6,
        folder: { parentPath: "", remoteId: "notes" },
      }];
    expect(shouldPauseCanonicalPlanForReviewV2(
      summarizeCanonicalPlanReviewV2(items).impactCount,
      10,
    )).toBe(true);
  });
});
