import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import {
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
  finalizeCanonicalPlanCandidateV2,
  orderCanonicalPlanItemsV2,
  sealCanonicalPlanV2,
} from "../src/sync/canonical-plan-v2";
import {
  attachBaseAncestorHashesV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import {
  SyncActionType,
  type LocalFileEntry,
  type LocalFolderEntry,
  type SyncPlanItem,
} from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

interface FolderSpec {
  id: string;
  name: string;
  parentId?: string;
}

interface FileSpec {
  id: string;
  name: string;
  parentId?: string;
  hash?: string | null;
  cTag?: string | null;
  size?: number;
}

function envelope(input: {
  folders?: FolderSpec[];
  files?: FileSpec[];
  folderAnchors?: FolderAnchorV2[] | null;
  fileAnchors?: SyncAnchorV2[];
  commitSeq?: number;
}): SyncStateEnvelopeV2 {
  const items: DriveItem[] = [
    ...(input.folders ?? []).map((folder): DriveItem => ({
      id: folder.id,
      name: folder.name,
      folder: {},
      parentReference: {
        id: folder.parentId ?? scope.filesRootId,
      },
      eTag: `etag-${folder.id}`,
    })),
    ...(input.files ?? []).map((file): DriveItem => ({
      id: file.id,
      name: file.name,
      file: {
        hashes: file.hash === null
          ? {}
          : { sha256Hash: file.hash ?? hashA },
      },
      parentReference: {
        id: file.parentId ?? scope.filesRootId,
      },
      size: file.size ?? 10,
      eTag: `etag-${file.id}`,
      cTag: file.cTag === null
        ? undefined
        : file.cTag ?? `ctag-${file.id}`,
    })),
  ];
  const result: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 1,
      commitSeq: input.commitSeq ?? 7,
      committedAt: 1,
    },
    scope,
    remoteIndex: buildRemoteIndexV2(
      items,
      scope.filesRootId,
      null,
      2,
    ).index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.fileAnchors ?? []).map((anchor) => [
          anchor.anchorId,
          anchor,
        ]),
      ),
    },
  };
  if (input.folderAnchors !== null) {
    result.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: Object.fromEntries(
        (input.folderAnchors ?? []).map((anchor) => [
          anchor.anchorId,
          anchor,
        ]),
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
  remoteCTag?: string,
): SyncAnchorV2 {
  return {
    anchorId: `file:${remoteId}`,
    remoteId,
    lastPath,
    contentHash: hash,
    size,
    remoteETag: `etag-${remoteId}`,
    ...(remoteCTag ? { remoteCTag } : {}),
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
}

function localFile(
  path: string,
  hash = hashA,
  size = 10,
): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

function build(input: {
  state: SyncStateEnvelopeV2;
  localFiles: LocalFileEntry[];
  localFolders?: LocalFolderEntry[];
  localMoveHints?: Parameters<
    typeof buildCanonicalPlanCandidateV2
  >[0]["localMoveHints"];
}) {
  return buildCanonicalPlanCandidateV2({
    envelope: input.state,
    localFiles: input.localFiles,
    localFolders: input.localFolders ?? [],
    localFolderScanComplete: true,
    skippedLarge: [],
    localMoveHints: input.localMoveHints,
    configDir: ".obsidian",
    automaticDeleteLocalFiles: false,
  });
}

describe("canonical V2 plan candidate", () => {
  it("reconciles a same-path remote identity replacement through the content matrix", async () => {
    const cases = [
      {
        name: "both unchanged",
        local: localFile("note.md"),
        remoteHash: hashA,
        expectedType: null,
      },
      {
        name: "local changed",
        local: localFile("note.md", hashB),
        remoteHash: hashA,
        expectedType: SyncActionType.Upload,
      },
      {
        name: "remote changed",
        local: localFile("note.md", hashA),
        remoteHash: hashB,
        expectedType: SyncActionType.Download,
      },
      {
        name: "both changed differently",
        local: localFile("note.md", "c".repeat(64)),
        remoteHash: hashB,
        expectedType: SyncActionType.Conflict,
      },
      {
        name: "both converged to the same new content",
        local: localFile("note.md", hashB),
        remoteHash: hashB,
        expectedType: null,
      },
    ] as const;

    for (const testCase of cases) {
      const state = envelope({
        files: [{ id: "new-id", name: "note.md", hash: testCase.remoteHash }],
        folderAnchors: [],
        fileAnchors: [fileAnchor("old-id", "note.md")],
      });
      const candidate = build({ state, localFiles: [testCase.local] });
      const finalized = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "vault",
        accountId: "account",
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: false,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: async () => {
          throw new Error("known SHA-256 must not download");
        },
      });

      expect(
        finalized.items.map((item) => item.type),
        testCase.name,
      ).toEqual(testCase.expectedType ? [testCase.expectedType] : []);
      if (testCase.expectedType === SyncActionType.Upload) {
        expect(finalized.items[0]).toMatchObject({
          remote: { driveId: "new-id" },
          baseEtag: "etag-new-id",
        });
      }
      if (testCase.expectedType === SyncActionType.Conflict) {
        expect(finalized.items[0]).toMatchObject({
          reason: "reason.bothSidesModified",
          remote: { driveId: "new-id" },
        });
      }
      expect(finalized.baseUpserts).toEqual(
        testCase.expectedType === null
          ? [{
              path: "note.md",
              hash: testCase.local.hash,
              size: testCase.local.size,
              eTag: "etag-new-id",
            }]
          : [],
      );
    }
  });

  it("verifies a hashless replacement before choosing upload and defers on failed proof", async () => {
    const state = envelope({
      files: [{ id: "new-id", name: "note.md", hash: null }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("old-id", "note.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("note.md", hashB)],
    });
    const resolved = await finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: state,
      vaultName: "vault",
      accountId: "account",
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: false,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    });
    expect(resolved.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "note.md",
        baseEtag: "etag-new-id",
        remote: expect.objectContaining({ driveId: "new-id" }),
      }),
    ]);

    const deferred = await finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: state,
      vaultName: "vault",
      accountId: "account",
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: false,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => {
        throw new Error("offline");
      },
    });
    expect(deferred.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: "note.md",
        reason: "reason.identityReplacement.verificationPending",
      }),
    ]);
  });

  it("keeps hashless replacement verification inside the shared ten-download budget", async () => {
    const replacements = Array.from({ length: 11 }, (_, index) => ({
      path: `note-${index}.md`,
      oldId: `old-${index}`,
      newId: `new-${index}`,
    }));
    const state = envelope({
      files: replacements.map((entry) => ({
        id: entry.newId,
        name: entry.path,
        hash: null,
      })),
      folderAnchors: [],
      fileAnchors: replacements.map((entry) =>
        fileAnchor(entry.oldId, entry.path)),
    });
    const candidate = build({
      state,
      localFiles: replacements.map((entry) => localFile(entry.path)),
    });
    let downloads = 0;
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: state,
      vaultName: "vault",
      accountId: "account",
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: false,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => {
        downloads++;
        return hashA;
      },
    });

    expect(downloads).toBe(10);
    expect(finalized.baseUpserts).toHaveLength(10);
    expect(finalized.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        reason: "reason.identityReplacement.verificationPending",
      }),
    ]);
    expect(finalized.contentVerification).toMatchObject({
      candidates: 11,
      downloads: 10,
      skippedDownloads: 1,
    });
  });

  it("uses an explicit unknown state for replacement plus local relocation", () => {
    const state = envelope({
      files: [{ id: "new-id", name: "old.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("old-id", "old.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("new.md")],
    });
    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: "old.md",
        reason: "reason.identityReplacement.ambiguous",
      }),
    ]);
  });

  it("leaves an ordinary missing remote identity to normal delete/modify rules", () => {
    const unchanged = build({
      state: envelope({
        files: [],
        folderAnchors: [],
        fileAnchors: [fileAnchor("deleted-id", "note.md")],
      }),
      localFiles: [localFile("note.md")],
    });
    expect(unchanged.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: "note.md",
        reason: "reason.fileDeletedFromRemote",
      }),
    ]);

    const modified = build({
      state: envelope({
        files: [],
        folderAnchors: [],
        fileAnchors: [fileAnchor("deleted-id", "note.md")],
      }),
      localFiles: [localFile("note.md", hashB)],
    });
    expect(modified.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "note.md",
        reason: "reason.remoteDeletedLocalModified",
      }),
    ]);
  });

  it("moves a hashless remote identity directly when its content tag is unchanged", () => {
    const state = envelope({
      folders: [{ id: "folder", name: "sub" }],
      files: [{
        id: "file",
        name: "new.md",
        parentId: "folder",
        hash: null,
        cTag: "ctag-content-1",
      }],
      folderAnchors: [folderAnchor("folder", "sub")],
      fileAnchors: [fileAnchor("file", "old.md", hashA, 10, "ctag-content-1")],
    });

    const candidate = build({
      state,
      localFiles: [localFile("old.md")],
      localFolders: localFolders("sub"),
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.MoveLocalFile,
        path: "sub/new.md",
        renameFrom: "old.md",
      }),
    ]);
    expect(candidate.identityMoveVerifications).toEqual([]);
  });

  it.each([false, true])(
    "strictly verifies a legacy moved anchor without exposing download or delete (auto delete %s)",
    async (autoDeleteLocalFiles) => {
      const state = envelope({
        folders: [{ id: "folder", name: "sub" }],
        files: [{
          id: "file",
          name: "new.md",
          parentId: "folder",
          hash: null,
          cTag: "ctag-content-1",
        }],
        folderAnchors: [folderAnchor("folder", "sub")],
        fileAnchors: [fileAnchor("file", "old.md")],
      });
      const candidate = build({
        state,
        localFiles: [localFile("old.md")],
        localFolders: localFolders("sub"),
      });
      let reads = 0;

      const finalized = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles,
          mergeNonOverlappingText: false,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: async (_item, progress) => {
          reads++;
          expect(progress).toEqual({ current: 1, total: 1 });
          return hashA;
        },
      });

      expect(reads).toBe(1);
      expect(finalized.items).toEqual([
        expect.objectContaining({
          type: SyncActionType.MoveLocalFile,
          path: "sub/new.md",
          renameFrom: "old.md",
        }),
      ]);
      expect(finalized.items.some((item) => [
        SyncActionType.Download,
        SyncActionType.DeleteLocal,
        SyncActionType.ConfirmLocalDelete,
      ].includes(item.type))).toBe(false);
    },
  );

  it("keeps both paths when legacy move verification differs or fails", async () => {
    const state = envelope({
      folders: [{ id: "folder", name: "sub" }],
      files: [{
        id: "file",
        name: "new.md",
        parentId: "folder",
        hash: null,
        cTag: "ctag-content-2",
      }],
      folderAnchors: [folderAnchor("folder", "sub")],
      fileAnchors: [fileAnchor("file", "old.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("old.md")],
      localFolders: localFolders("sub"),
    });
    const finalize = (resolver: () => Promise<string>) =>
      finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: true,
          mergeNonOverlappingText: false,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: resolver,
      });

    const different = await finalize(async () => hashB);
    expect(different.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: "sub/new.md",
        reason: "reason.identityMove.contentChanged",
      }),
    ]);
    const failed = await finalize(async () => {
      throw new Error("offline");
    });
    expect(failed.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: "sub/new.md",
        reason: "reason.identityMove.verificationFailed",
      }),
    ]);
  });

  it("lets unresolved identity moves own every involved path before ordinary file actions", () => {
    const changedVersion = envelope({
      folders: [{ id: "folder", name: "sub" }],
      files: [{
        id: "file",
        name: "new.md",
        parentId: "folder",
        hash: null,
        cTag: "ctag-content-2",
      }],
      folderAnchors: [folderAnchor("folder", "sub")],
      fileAnchors: [fileAnchor("file", "old.md", hashA, 10, "ctag-content-1")],
    });
    const locallyModified = structuredClone(changedVersion);
    locallyModified.anchors.byAnchorId["file:file"]!.remoteCTag = "ctag-content-2";
    const targetOccupied = structuredClone(locallyModified);
    const candidates = [
      {
        candidate: build({
        state: changedVersion,
        localFiles: [localFile("old.md")],
        localFolders: localFolders("sub"),
        }),
        reason: "reason.identityMove.bothSidesChanged",
      },
      {
        candidate: build({
        state: locallyModified,
        localFiles: [localFile("old.md", hashB)],
        localFolders: localFolders("sub"),
        }),
        reason: "reason.identityMove.bothSidesChanged",
      },
      {
        candidate: build({
        state: targetOccupied,
        localFiles: [localFile("old.md"), localFile("sub/new.md", hashB)],
        localFolders: localFolders("sub"),
        }),
        reason: "reason.identityMove.localTargetOccupied",
      },
    ];

    for (const { candidate, reason } of candidates) {
      expect(candidate.items).toHaveLength(1);
      expect(candidate.items[0]).toMatchObject({
        type: SyncActionType.FolderDeferred,
        reason,
      });
      expect(candidate.items.some((item) => [
        SyncActionType.Upload,
        SyncActionType.Download,
        SyncActionType.DeleteRemote,
        SyncActionType.DeleteLocal,
        SyncActionType.ConfirmLocalDelete,
      ].includes(item.type))).toBe(false);
    }
  });

  it("uploads same-content copies while keeping the old cloud path as a normal decision", () => {
    const ambiguousLocalRename = envelope({
      files: [{ id: "file", name: "old.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("file", "old.md")],
    });

    const candidate = build({
      state: ambiguousLocalRename,
      localFiles: [localFile("a.md"), localFile("b.md")],
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "a.md",
      }),
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "b.md",
      }),
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "old.md",
        reason: "reason.renameIdentityAmbiguous",
      }),
    ]);
    expect(candidate.items).not.toContainEqual(expect.objectContaining({
      type: SyncActionType.FolderDeferred,
    }));
  });

  it("keeps the old cloud path as a decision after every copy is committed", () => {
    const committedCopies = envelope({
      files: [
        { id: "old", name: "old.md" },
        { id: "copy-a", name: "a.md" },
        { id: "copy-b", name: "b.md" },
      ],
      folderAnchors: [],
      fileAnchors: [
        fileAnchor("old", "old.md"),
        fileAnchor("copy-a", "a.md"),
        fileAnchor("copy-b", "b.md"),
      ],
    });

    const candidate = build({
      state: committedCopies,
      localFiles: [localFile("a.md"), localFile("b.md")],
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "old.md",
        reason: "reason.renameIdentityAmbiguous",
      }),
    ]);
  });

  it("keeps legacy move verification inside the shared ten-read budget", async () => {
    const moves = Array.from({ length: 11 }, (_, index) => ({
      id: `file-${index}`,
      oldPath: `old-${index}.md`,
      newName: `new-${index}.md`,
    }));
    const state = envelope({
      folders: [{ id: "folder", name: "sub" }],
      files: moves.map((entry) => ({
        id: entry.id,
        name: entry.newName,
        parentId: "folder",
        hash: null,
      })),
      folderAnchors: [folderAnchor("folder", "sub")],
      fileAnchors: moves.map((entry) =>
        fileAnchor(entry.id, entry.oldPath)),
    });
    const candidate = build({
      state,
      localFiles: moves.map((entry) => localFile(entry.oldPath)),
      localFolders: localFolders("sub"),
    });
    let reads = 0;

    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: false,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async (_item, progress) => {
        reads++;
        expect(progress.total).toBe(10);
        return hashA;
      },
    });

    expect(reads).toBe(10);
    expect(finalized.items.filter((item) =>
      item.type === SyncActionType.MoveLocalFile)).toHaveLength(10);
    expect(finalized.items.filter((item) =>
      item.type === SyncActionType.FolderDeferred)).toHaveLength(1);
    expect(finalized.items.find((item) =>
      item.type === SyncActionType.FolderDeferred)).toMatchObject({
      reason: "reason.identityMove.verificationFailed",
    });
    expect(finalized.contentVerification).toMatchObject({
      candidates: 11,
      downloads: 10,
      skippedDownloads: 1,
    });
  });

  it("derives remote and ancestor file facts from one committed envelope", () => {
    const state = envelope({
      files: [
        { id: "stable", name: "stable.md" },
        { id: "remote-only", name: "remote-only.md", hash: hashB },
      ],
      folderAnchors: [],
      fileAnchors: [fileAnchor("stable", "stable.md")],
      commitSeq: 11,
    });

    const candidate = build({
      state,
      localFiles: [localFile("stable.md", hashB)],
    });

    expect(candidate).toMatchObject({
      version: 2,
      status: "planned",
      scope,
      sourceCommitSeq: 11,
      lastTotalFiles: 1,
    });
    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "stable.md",
        baseEtag: "etag-stable",
      }),
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "remote-only.md",
        remote: expect.objectContaining({
          driveId: "remote-only",
        }),
      }),
    ]);
  });

  it("expresses a folder rename and incoming anchored file in one action model", () => {
    const state = envelope({
      folders: [
        { id: "text", name: "text" },
        { id: "nested", name: "nested", parentId: "text" },
      ],
      files: [{ id: "report", name: "report.md" }],
      folderAnchors: [
        folderAnchor("text", "text"),
        folderAnchor("nested", "text/nested", "text"),
      ],
      fileAnchors: [fileAnchor("report", "report.md")],
    });
    const localFiles = [
      localFile("text-renamed/nested/report.md"),
    ];
    const before = structuredClone({
      state,
      localFiles,
    });

    const candidate = build({
      state,
      localFiles,
      localFolders: localFolders(
        "text-renamed",
        "text-renamed/nested",
      ),
      localMoveHints: [{
        version: 1,
        scope,
        remoteId: "text",
        fromPath: "text",
        toPath: "text-renamed",
        observedAt: 10,
      }],
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.MoveRemoteFolder,
        path: "text-renamed",
        renameFrom: "text",
        folder: expect.objectContaining({ remoteId: "text" }),
      }),
      expect.objectContaining({
        type: SyncActionType.RenameRemote,
        path: "text-renamed/nested/report.md",
        renameFrom: "report.md",
        targetParentRemoteId: "nested",
        remote: expect.objectContaining({ driveId: "report" }),
      }),
    ]);
    expect({ state, localFiles }).toEqual(before);
  });

  it("fails closed instead of returning a partial file-only candidate", () => {
    const state = envelope({
      files: [{ id: "remote", name: "remote.md" }],
      folderAnchors: null,
    });

    expect(build({
      state,
      localFiles: [],
    })).toMatchObject({
      status: "rejected",
      rejectionReason: "folder-anchors-uninitialized",
      items: [],
    });
  });

  it("keeps unanchored descendant evidence non-executable and bounded", () => {
    const folders = [
      { id: "obsidian", name: ".obsidian" },
      { id: "plugins", name: "plugins", parentId: "obsidian" },
      { id: "easy-sync", name: "easy-sync", parentId: "plugins" },
    ];
    const files = Array.from({ length: 11 }, (_, index) => ({
      id: `plugin-file-${index}`,
      name: `file-${index}.json`,
      parentId: "easy-sync",
      hash: hashA,
    }));
    const state = envelope({
      folders,
      files,
      folderAnchors: [],
    });
    const candidate = build({
      state,
      localFiles: files.map((file) =>
        localFile(`.obsidian/plugins/easy-sync/${file.name}`)),
      localFolders: localFolders(
        ".obsidian",
        ".obsidian/plugins",
        ".obsidian/plugins/easy-sync",
      ),
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: ".obsidian",
      }),
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: ".obsidian/plugins",
      }),
      expect.objectContaining({
        type: SyncActionType.FolderDeferred,
        path: ".obsidian/plugins/easy-sync",
      }),
    ]);
    expect(candidate.unanchoredDescendantEvidence).toHaveLength(10);
    expect(candidate.unanchoredDescendantEvidence.map((item) => item.path))
      .toEqual(Array.from({ length: 11 }, (_, index) =>
        `.obsidian/plugins/easy-sync/file-${index}.json`)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 10));
  });

  it("applies the file scope before both classification and identity planning", () => {
    const state = envelope({
      files: [{ id: "private", name: "private.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("private", "private.md")],
    });

    const candidate = buildCanonicalPlanCandidateV2({
      envelope: state,
      localFiles: [localFile("excluded/private-renamed.md")],
      localFolders: [],
      localFolderScanComplete: true,
      skippedLarge: [],
      includeFilePath: (path) => !path.startsWith("excluded/")
        && path !== "private.md",
      configDir: ".obsidian",
      automaticDeleteLocalFiles: false,
    });

    expect(candidate.status).toBe("planned");
    expect(candidate.items).toEqual([]);
  });

  it("finalizes equal-content evidence, automatic handling, tokens, and threshold", async () => {
    const equalState = envelope({
      files: [{ id: "equal", name: "equal.md" }],
      folderAnchors: [],
    });
    const equalCandidate = build({
      state: equalState,
      localFiles: [localFile("equal.md")],
    });
    const resolver = async () => {
      throw new Error("metadata equality must not download");
    };

    const equalFinal = await finalizeCanonicalPlanCandidateV2({
      candidate: equalCandidate,
      envelope: equalState,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: resolver,
    });

    expect(equalFinal.items).toEqual([]);
    expect(equalFinal.baseUpserts).toEqual([{
      path: "equal.md",
      hash: hashA,
      size: 10,
      eTag: "etag-equal",
    }]);
    expect(equalFinal.contentVerification.results).toEqual([
      expect.objectContaining({
        path: "equal.md",
        outcome: "equal",
        proof: "remoteSha256",
        downloaded: false,
      }),
    ]);

    const deleteState = envelope({
      files: [],
      folderAnchors: [],
      fileAnchors: [fileAnchor("removed", "removed.md")],
    });
    const deleteCandidate = build({
      state: deleteState,
      localFiles: [localFile("removed.md")],
    });
    const deleteFinal = await finalizeCanonicalPlanCandidateV2({
      candidate: deleteCandidate,
      envelope: deleteState,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: resolver,
    });

    expect(deleteFinal.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.DeleteLocal,
        path: "removed.md",
      }),
    ]);
    expect(deleteFinal.items[0].decisionToken).toBeUndefined();
    expect(deleteFinal.requiresThresholdConfirmation).toBe(true);
  });

  it("characterizes ordinary remote-only changes below the review threshold", async () => {
    const state = envelope({
      files: [
        { id: "modified", name: "modified.md", hash: hashB },
        { id: "stable-a", name: "stable-a.md" },
        { id: "stable-b", name: "stable-b.md" },
        { id: "stable-c", name: "stable-c.md" },
        { id: "stable-d", name: "stable-d.md" },
      ],
      folderAnchors: [],
      fileAnchors: [
        fileAnchor("modified", "modified.md"),
        fileAnchor("deleted", "deleted.md"),
        fileAnchor("stable-a", "stable-a.md"),
        fileAnchor("stable-b", "stable-b.md"),
        fileAnchor("stable-c", "stable-c.md"),
        fileAnchor("stable-d", "stable-d.md"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [
        localFile("modified.md"),
        localFile("deleted.md"),
        localFile("stable-a.md"),
        localFile("stable-b.md"),
        localFile("stable-c.md"),
        localFile("stable-d.md"),
      ],
    });
    const finalize = (autoDeleteLocalFiles: boolean) =>
      finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: async () => {
          throw new Error("anchored remote changes must not need a download");
        },
      });

    const manualDelete = await finalize(false);
    expect(manualDelete.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "modified.md",
      }),
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: "deleted.md",
      }),
    ]);
    expect(manualDelete.requiresThresholdConfirmation).toBe(false);

    const automaticDelete = await finalize(true);
    expect(automaticDelete.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "modified.md",
      }),
      expect.objectContaining({
        type: SyncActionType.DeleteLocal,
        path: "deleted.md",
      }),
    ]);
    // Two executable changes out of six anchors remain below the existing
    // large-change gate.
    expect(automaticDelete.requiresThresholdConfirmation).toBe(false);
  });

  it("binds downloaded difference evidence and the exact V2 ancestor", async () => {
    const state = envelope({
      files: [{ id: "conflict", name: "conflict.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("conflict", "conflict.md")],
    });
    delete state.remoteIndex.itemsById.conflict!.contentHash;
    state.remoteIndex.itemsById.conflict!.eTag = "etag-new";
    const candidate = build({
      state,
      localFiles: [localFile("conflict.md", hashB)],
    });

    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async (_item, progress) => {
        expect(progress).toEqual({ current: 1, total: 1 });
        return "c".repeat(64);
      },
    });

    expect(finalized.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "conflict.md",
        contentComparison: expect.objectContaining({
          result: "different",
          remoteETag: "etag-new",
          remoteHash: "c".repeat(64),
        }),
        decisionToken: expect.objectContaining({
          vaultName: "Vault",
          accountId: scope.accountId,
          scope,
          ancestorHash: hashA,
        }),
      }),
    ]);
    expect(finalized.contentVerification).toMatchObject({
      candidates: 1,
      cachedEvidence: 0,
      downloads: 1,
      skippedDownloads: 0,
    });
  });

  it("rejects finalization against a different envelope revision", async () => {
    const state = envelope({ folderAnchors: [] });
    const candidate = build({ state, localFiles: [] });
    const newer = structuredClone(state);
    newer.meta.commitSeq++;

    await expect(finalizeCanonicalPlanCandidateV2({
      candidate,
      envelope: newer,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    })).rejects.toThrow("no longer matches");
  });

  it("seals the exact equal-content base transition at the new commit", async () => {
    const state = envelope({
      files: [{ id: "equal", name: "equal.md" }],
      folderAnchors: [],
      commitSeq: 21,
    });
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: build({
        state,
        localFiles: [localFile("equal.md")],
      }),
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    });
    const committed = upsertBaseStateEnvelopeV2(
      state,
      finalized.baseUpserts,
      22,
    );

    const sealed = sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: committed,
    });

    expect(sealed.sourceCommitSeq).toBe(22);
    expect(sealed.items).toEqual([]);
    expect(sealed.canonicalIdentity).toMatchObject({
      version: 2,
      scope,
      sourceCommitSeq: 22,
    });
    expect(sealed.canonicalReview).toEqual({
      counts: {
        uploads: 0,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      impactCount: 0,
    });
    expect(sealed.canonicalIdentity.digest).toBe(
      canonicalPlanDigestV2({
        items: sealed.items,
        lastTotalFiles: sealed.lastTotalFiles,
        scope,
        sourceCommitSeq: 22,
      }),
    );
  });

  it("seals exact content evidence into the same first unpublished migration candidate", async () => {
    const state = envelope({
      files: [{ id: "equal", name: "equal.md" }],
      folderAnchors: [],
      commitSeq: 1,
    });
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: build({
        state,
        localFiles: [localFile("equal.md")],
      }),
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    });
    const controllerProjection = upsertBaseStateEnvelopeV2(
      state,
      finalized.baseUpserts,
      state.meta.committedAt,
    );
    const unpublishedCandidate = {
      ...controllerProjection,
      meta: { ...state.meta },
    };

    expect(() => sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: unpublishedCandidate,
    })).toThrow("outside its verified base reconciliation");

    const sealed = sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: unpublishedCandidate,
      unpublishedMigrationCandidate: true,
    });

    expect(sealed.sourceCommitSeq).toBe(1);
    expect(sealed.items).toEqual([]);
    expect(sealed.canonicalIdentity).toMatchObject({
      sourceCommitSeq: 1,
      scope,
    });
  });

  it("seals an ancestor attachment only when the state controller reports its exact hash", async () => {
    const state = envelope({
      files: [{ id: "equal", name: "equal.md" }],
      folderAnchors: [],
      commitSeq: 21,
    });
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: build({
        state,
        localFiles: [localFile("equal.md")],
      }),
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    });
    const baseCommitted = upsertBaseStateEnvelopeV2(
      state,
      finalized.baseUpserts,
      22,
    );
    const ancestorHashesByPath = { "equal.md": hashA };
    const committed = attachBaseAncestorHashesV2(
      state,
      baseCommitted,
      finalized.baseUpserts,
      ancestorHashesByPath,
      22,
    );

    expect(() => sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: committed,
    })).toThrow("outside its verified base reconciliation");

    const sealed = sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: committed,
      ancestorHashesByPath,
    });

    expect(sealed.sourceCommitSeq).toBe(22);
    expect(
      committed.anchors.byAnchorId["file:equal"]?.ancestorHash,
    ).toBe(hashA);
  });

  it("rejects unrelated state changes and surviving actions on reconciled paths", async () => {
    const state = envelope({
      files: [{ id: "equal", name: "equal.md" }],
      folderAnchors: [],
    });
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: build({
        state,
        localFiles: [localFile("equal.md")],
      }),
      envelope: state,
      vaultName: "Vault",
      accountId: scope.accountId,
      automaticHandlingPolicy: {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      baselineReconstructionIncomplete: false,
      resolveRemoteContentHash: async () => hashA,
    });
    const committed = upsertBaseStateEnvelopeV2(
      state,
      finalized.baseUpserts,
      2,
    );
    const unrelated = structuredClone(committed);
    unrelated.meta.commitSeq++;

    expect(() => sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: state,
      committedEnvelope: unrelated,
    })).toThrow("outside its verified base reconciliation");
    expect(() => sealCanonicalPlanV2({
      finalized: {
        ...finalized,
        items: [{
          type: SyncActionType.Upload,
          path: "equal.md",
          local: localFile("equal.md"),
        }],
      },
      sourceEnvelope: state,
      committedEnvelope: committed,
    })).toThrow("still acts on a reconciled path");
  });

  it("orders dependencies and digests every mutation authorization fact", () => {
    const items: SyncPlanItem[] = [
      {
        type: SyncActionType.DeleteRemoteFolder,
        path: "parent/child",
        folder: { remoteId: "child", parentPath: "parent" },
      },
      {
        type: SyncActionType.Upload,
        path: "parent/note.md",
        local: localFile("parent/note.md"),
      },
      {
        type: SyncActionType.CreateRemoteFolder,
        path: "parent",
        folder: { parentRemoteId: scope.filesRootId, parentPath: "" },
      },
      {
        type: SyncActionType.RenameRemote,
        path: "parent/moved.md",
        renameFrom: "old.md",
        targetParentRemoteId: "parent",
        local: localFile("parent/moved.md"),
        remote: {
          path: "old.md",
          driveId: "file",
          parentId: scope.filesRootId,
          size: 10,
          mtime: 1,
          eTag: "etag-file",
          cTag: "ctag-file",
        },
      },
    ];
    const ordered = orderCanonicalPlanItemsV2(items);
    expect(ordered.map((item) => item.type)).toEqual([
      SyncActionType.CreateRemoteFolder,
      SyncActionType.RenameRemote,
      SyncActionType.Upload,
      SyncActionType.DeleteRemoteFolder,
    ]);

    const digest = (planItems: SyncPlanItem[]) => canonicalPlanDigestV2({
      items: planItems,
      lastTotalFiles: 4,
      scope,
      sourceCommitSeq: 7,
    });
    const original = digest(items);
    const renamed = structuredClone(items);
    renamed[3]!.renameFrom = "other.md";
    const changedDrive = structuredClone(items);
    changedDrive[3]!.remote!.driveId = "other-file";
    const changedParent = structuredClone(items);
    changedParent[3]!.targetParentRemoteId = "other-parent";
    expect(new Set([
      original,
      digest(renamed),
      digest(changedDrive),
      digest(changedParent),
    ]).size).toBe(4);

    const reviewedConflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: "conflict.md",
      local: localFile("conflict.md", hashB),
      remote: {
        path: "conflict.md",
        driveId: "conflict",
        parentId: scope.filesRootId,
        size: 10,
        mtime: 1,
        eTag: "etag-conflict",
        cTag: "ctag-conflict",
      },
      decisionToken: {
        version: 1,
        vaultName: "Vault",
        accountId: scope.accountId,
        scope,
        local: { exists: true, hash: hashB, size: 10 },
        remote: {
          exists: true,
          driveId: "conflict",
          eTag: "etag-conflict",
        },
        ancestorHash: hashA,
      },
      contentComparison: {
        version: 1,
        result: "different",
        localHash: hashB,
        localSize: 10,
        remoteDriveId: "conflict",
        remoteETag: "etag-conflict",
        remoteSize: 10,
        remoteHash: "c".repeat(64),
      },
    };
    const reviewedDigest = digest([reviewedConflict]);
    const changedToken = structuredClone(reviewedConflict);
    changedToken.decisionToken!.ancestorHash = null;
    const changedReceipt = structuredClone(reviewedConflict);
    changedReceipt.contentComparison!.remoteHash = "d".repeat(64);
    expect(new Set([
      reviewedDigest,
      digest([changedToken]),
      digest([changedReceipt]),
    ]).size).toBe(3);
  });

  it("keeps folder/identity array surgery out of SyncExecutor", () => {
    const source = readFileSync(
      new URL("../src/sync/sync-executor.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("appendExecutableV2FolderPlan");
    expect(source).not.toContain("planFolderStateV2(");
    expect(source).not.toContain("planIdentityRenamesV2(");
    expect(source).toContain("buildCanonicalPlanCandidateV2({");
    expect(source).toContain("finalizeCanonicalPlanCandidateV2({");
    expect(source).toContain("sealCanonicalPlanV2({");
  });
});
