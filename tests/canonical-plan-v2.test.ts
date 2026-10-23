import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import {
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
  describeCanonicalPlanItemFactsDriftV2,
  finalizeCanonicalPlanCandidateV2,
  isAtOrBelowPath,
  isProtectedFolderDeletePath,
  orderCanonicalPlanItemsV2,
  sealCanonicalPlanV2,
} from "../src/sync/canonical-plan-v2";

describe("cross-device path identity", () => {
  it("treats OneDrive case aliases as the same protected subtree", () => {
    expect(isAtOrBelowPath(".OBSIDIAN/Plugins/Example", ".obsidian/plugins"))
      .toBe(true);
    expect(isProtectedFolderDeletePath(".OBSIDIAN/Plugins", ".obsidian"))
      .toBe(true);
    expect(isAtOrBelowPath(".obsidian-other", ".obsidian"))
      .toBe(false);
  });

  it("protects only the config root and the community-plugin subtree from folder deletion", () => {
    expect(isProtectedFolderDeletePath(".obsidian", ".obsidian")).toBe(true);
    expect(isProtectedFolderDeletePath(".OBSIDIAN", ".obsidian")).toBe(true);
    expect(isProtectedFolderDeletePath(".obsidian/plugins", ".obsidian"))
      .toBe(true);
    expect(isProtectedFolderDeletePath(".obsidian/plugins/dataview", ".obsidian"))
      .toBe(true);
    // Theme and snippet directories are user content: they follow the
    // ordinary folder delete chain instead of the protected-config deferral.
    expect(isProtectedFolderDeletePath(".obsidian/themes", ".obsidian"))
      .toBe(false);
    expect(isProtectedFolderDeletePath(".obsidian/themes/Primary", ".obsidian"))
      .toBe(false);
    expect(isProtectedFolderDeletePath(".obsidian/snippets", ".obsidian"))
      .toBe(false);
    expect(isProtectedFolderDeletePath(".obsidian-other", ".obsidian"))
      .toBe(false);
  });
});
import {
  attachBaseAncestorHashesV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import { isEasySyncInternalPath } from "../src/sync/local-scanner";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import {
  planDigest,
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
  localFileMoveHints?: Parameters<
    typeof buildCanonicalPlanCandidateV2
  >[0]["localFileMoveHints"];
  includeFilePath?: (path: string) => boolean;
}) {
  return buildCanonicalPlanCandidateV2({
    envelope: input.state,
    localFiles: input.localFiles,
    localFolders: input.localFolders ?? [],
    localFolderScanComplete: true,
    skippedLarge: [],
    localMoveHints: input.localMoveHints,
    localFileMoveHints: input.localFileMoveHints,
    includeFilePath: input.includeFilePath,
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
      configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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

  it("defers a reconcile action whose expected remote facts no longer match the projection", () => {
    // 计划层延后（`RetryLater` + `reason.identityReplacement.verificationPending`，
    // 文案自陈「本轮未作更改」、设计语义＝下一轮再验证）——执行器暂停门第四豁免族
    // （`planningDeferredErrors`）唯一的计划生产点，本项钉住「计划的产出 reason」与
    // 「执行器按同一 reason 计入豁免族」两处字面量的同一性。
    // 构造条件：reconcile 动作按锚点拼写（"Note.md"）通过范围谓词，占用者节点的
    // 投影拼写（"note.md"）没通过 ⇒ `remoteFilesById` 找不到动作预期的远端事实，
    // 守卫把该路径交回普通规划而不是按失效预期改写身份。
    const state = envelope({
      files: [{ id: "rebuilt-id", name: "note.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("gone-id", "Note.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("Note.md")],
      includeFilePath: (path) => path !== "note.md",
    });
    expect(candidate.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: SyncActionType.RetryLater,
        path: "Note.md",
        reason: "reason.identityReplacement.verificationPending",
      }),
    ]));
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
      configDir: ".obsidian",
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

    // A unilateral remote move+edit (local unchanged) converges as a move
    // instead of an unresolved conflict; the bytes follow next round.
    const unilateral = build({
      state: changedVersion,
      localFiles: [localFile("old.md")],
      localFolders: localFolders("sub"),
    });
    expect(unilateral.items).toHaveLength(1);
    expect(unilateral.items[0]).toMatchObject({
      type: SyncActionType.MoveLocalFile,
      path: "sub/new.md",
    });
    expect(unilateral.items.some((item) => [
      SyncActionType.Upload,
      SyncActionType.Download,
      SyncActionType.DeleteRemote,
      SyncActionType.DeleteLocal,
      SyncActionType.ConfirmLocalDelete,
    ].includes(item.type))).toBe(false);

    const candidates = [
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

  it("owns a spelling-alias relocation target instead of a doomed remote move", () => {
    const state = envelope({
      folders: [{ id: "folder", name: "videos" }],
      files: [{ id: "file", name: "old.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("file", "old.md")],
    });
    const candidate = build({
      state,
      localFiles: [localFile("Videos/old.md")],
      localFolders: localFolders("Videos"),
    });

    // The identity layer withholds the move (the destination parent is only a
    // spelling alias), and no file action may take over those paths: the plan
    // stays at the two actionable rows — the ordinary same-content decision on
    // the old cloud path plus the folder-level deferral.
    expect(candidate.items.map((item) => `${item.type}|${item.path}|${item.reason ?? ""}`)).toEqual([
      `conflict|old.md|reason.renameIdentityAmbiguous`,
      `folderDeferred|Videos|reason.folder.unanchored-shared-folder`,
    ]);
    expect(candidate.items.some((item) => [
      SyncActionType.Upload,
      SyncActionType.Download,
      SyncActionType.DeleteRemote,
      SyncActionType.DeleteLocal,
      SyncActionType.ConfirmLocalDelete,
      SyncActionType.RenameRemote,
    ].includes(item.type))).toBe(false);
  });

  // A1 拼写别名（甲 2026-10-16 发现；乙口径 2026-10-16 落守卫并复锚）。
  // SC-19 的禁令管的是**可执行计划**与 mutation 回执，而 canonical plan 是所有文件夹
  // 计划项的单一咽喉 ⇒ 合同钉子按结果锚在这一层：文件夹层允许发出候选（它只延后或
  // 交候选），但分歧形状过 canonical plan 后不得留下任何可执行的文件夹路径 mutation。
  // 三条形状：①改名正向（索引 `videos`／本机 `Videos`）；②改名反向镜像（索引 `Videos`
  // ／本机 `videos`）；③未锚定分歧父下的新建（上游条件闸放行的那条接缝）。
  // 每条都同时断言"该项确实存在且被扣下"（folderDeferred 行），否则零动作可能只是
  // 因为上游压根没发候选而假绿。
  const spellingAliasFolderRows = (
    candidate: ReturnType<typeof build>,
  ) => candidate.items
    .filter((item) => item.type === SyncActionType.MoveRemoteFolder
      || item.type === SyncActionType.CreateRemoteFolder);

  it("A1-① leaves no remote folder move under a spelling-alias destination parent", () => {
    const state = envelope({
      folders: [
        { id: "parent", name: "videos" },
        { id: "sub", name: "Notes", parentId: "parent" },
      ],
      files: [{ id: "file-a", name: "a.md", parentId: "sub" }],
      folderAnchors: [
        folderAnchor("parent", "videos"),
        folderAnchor("sub", "videos/Notes", "parent"),
      ],
      fileAnchors: [fileAnchor("file-a", "videos/Notes/a.md")],
    });

    const candidate = build({
      state,
      localFiles: [localFile("Videos/Notes2/a.md")],
      localFolders: localFolders("Videos", "Videos/Notes2"),
      localMoveHints: [
        { version: 1, scope, remoteId: "parent", fromPath: "videos", toPath: "Videos", observedAt: 10 },
        { version: 1, scope, remoteId: "sub", fromPath: "videos/Notes", toPath: "Videos/Notes2", observedAt: 11 },
      ],
    });

    expect(candidate.status).toBe("planned");
    expect(spellingAliasFolderRows(candidate)).toEqual([]);
    // 反假绿：该项存在过，是本层把它扣下的。
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: "folderDeferred",
      path: "Videos/Notes2",
    }));
  });

  it("A1-② leaves no remote folder move in the mirrored spelling direction", () => {
    const state = envelope({
      folders: [
        { id: "parent", name: "Videos" },
        { id: "sub", name: "Notes", parentId: "parent" },
      ],
      files: [{ id: "file-a", name: "a.md", parentId: "sub" }],
      folderAnchors: [
        folderAnchor("parent", "Videos"),
        folderAnchor("sub", "Videos/Notes", "parent"),
      ],
      fileAnchors: [fileAnchor("file-a", "Videos/Notes/a.md")],
    });

    const candidate = build({
      state,
      localFiles: [localFile("videos/Notes2/a.md")],
      localFolders: localFolders("videos", "videos/Notes2"),
      localMoveHints: [
        { version: 1, scope, remoteId: "parent", fromPath: "Videos", toPath: "videos", observedAt: 10 },
        { version: 1, scope, remoteId: "sub", fromPath: "Videos/Notes", toPath: "videos/Notes2", observedAt: 11 },
      ],
    });

    expect(candidate.status).toBe("planned");
    expect(spellingAliasFolderRows(candidate)).toEqual([]);
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: "folderDeferred",
      path: "videos/Notes2",
    }));
  });

  it("A1-④ leaves no remote folder create under an unanchored spelling-alias parent", () => {
    const state = envelope({
      folders: [{ id: "parent", name: "videos" }],
      folderAnchors: [],
    });

    const candidate = build({
      state,
      localFiles: [],
      localFolders: localFolders("Videos", "Videos/New"),
    });

    expect(candidate.status).toBe("planned");
    expect(spellingAliasFolderRows(candidate)).toEqual([]);
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: "folderDeferred",
      path: "Videos/New",
    }));
  });

  // 控制项（必须绿）：分歧父的拼写与索引逐字节一致时，同一新建形状照旧发射 ⇒
  // 上一条的零动作来自本层的逐字节闸，而不是上游压根没发候选（反假绿）。
  it("A1-④ control: still creates that folder when the parent spelling is byte-identical", () => {
    const state = envelope({
      folders: [{ id: "parent", name: "Videos" }],
      folderAnchors: [],
    });

    const candidate = build({
      state,
      localFiles: [],
      localFolders: localFolders("Videos", "Videos/New"),
    });

    expect(candidate.status).toBe("planned");
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.CreateRemoteFolder,
      path: "Videos/New",
    }));
  });

  // F29 切片 1（2026-10-16）：文件夹移动的**后代投影闸**。归约层在提交文件夹移动
  // 回执时要求该文件夹之下每个 file anchor 在**已提交索引**里的投影 == 机械翻译
  // （`folder-state-reducer-v2.ts:810-823`）；云端把这棵子树改成非整体形状（后代被
  // 重新挂到别处／身份被替换／锚点成墓碑）时该断言结构性不可满足、回执永不提交
  // （野外案 2026-10-16：Android 1.5.9 整库停机、无出口）。本层做同构预检：不等即
  // 扣下、改产延后行（复用现成 reason，行内出口可用），后代先由文件层按现状对账、
  // 下一轮再把这次移动发出去 ⇒ 一轮延后自动收敛，而不是停机。
  // 每条都同时断言"确实没有可执行的文件夹移动"＋"该项到过本层且被扣下"，
  // 否则零动作可能只是因为上游压根没发候选而假绿（同 A1 钉子口径）。
  const folderMoveRows = (candidate: ReturnType<typeof build>) => candidate.items
    .filter((item) => item.type === SyncActionType.MoveLocalFolder
      || item.type === SyncActionType.MoveRemoteFolder);

  // 三个变体共享同一份现场：云端已把 `05秋招` 改名为 `05秋招记录`，本机还没动，
  // 该文件夹与其子文件夹都已锚定、后代文件也已锚定。
  //   diverged ＝ 云端把这个子文件夹搬到了别处（后代投影 ≠ 机械翻译）→ 闸门应扣下；
  //   tombstone＝ 后代锚点的远端身份已消失（墓碑）→ 闸门应扣下；
  //   converged＝ 后代跟着文件夹一起改名（投影 == 机械翻译）→ 照旧发射（控制项）。
  const f29Candidate = (variant: "diverged" | "converged" | "tombstone") => build({
    state: envelope({
      folders: variant === "diverged"
        ? [
          { id: "renamed", name: "05秋招记录" },
          { id: "misc", name: "其他" },
          { id: "child", name: "投递与面试记录", parentId: "misc" },
        ]
        : [
          { id: "renamed", name: "05秋招记录" },
          { id: "child", name: "投递与面试记录", parentId: "renamed" },
        ],
      files: [{ id: "file-y", name: "东风汽车.md", parentId: "child" }],
      folderAnchors: [
        folderAnchor("renamed", "05秋招"),
        folderAnchor("child", "05秋招/投递与面试记录", "renamed"),
      ],
      fileAnchors: [
        variant === "tombstone"
          ? { ...fileAnchor("file-y", "05秋招/投递与面试记录/东风汽车.md"), remoteId: undefined }
          : fileAnchor("file-y", "05秋招/投递与面试记录/东风汽车.md"),
      ],
    }),
    localFiles: [localFile("05秋招/投递与面试记录/东风汽车.md")],
    localFolders: localFolders("05秋招", "05秋招/投递与面试记录"),
  });

  it("F29-① withholds the move when a descendant projects somewhere else (field shape)", () => {
    // 云端已把 05秋招 改名为 05秋招记录，同时把它的子文件夹搬到了别处；本机还没动。
    const candidate = f29Candidate("diverged");

    expect(candidate.status).toBe("planned");
    expect(folderMoveRows(candidate)).toEqual([]);
    // 反假绿：这项确实到过本层，是被后代投影闸扣下的。
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: "folderDeferred",
      path: "05秋招记录",
      reason: "reason.folder.remote-subtree-changed",
    }));
    // 扣下文件夹移动不连坐后代对账：文件层照旧按现状把它搬到云端现位置。
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.MoveLocalFile,
      path: "其他/投递与面试记录/东风汽车.md",
    }));
  });

  it("F29-② withholds the move when a descendant anchor lost its remote identity", () => {
    // 同一形状的另一子情形（实跑判定为野外最可能的一种）：后代锚点成墓碑。
    const candidate = f29Candidate("tombstone");

    expect(candidate.status).toBe("planned");
    expect(folderMoveRows(candidate)).toEqual([]);
    expect(candidate.items).toContainEqual(expect.objectContaining({
      type: "folderDeferred",
      path: "05秋招记录",
      reason: "reason.folder.remote-subtree-changed",
    }));
  });

  // 控制项（必须绿）：后代随文件夹一起改名（投影 == 机械翻译）时照旧发射 ⇒ 上两条的
  // 零动作来自本层的投影闸，而不是上游没发候选或闸门过宽（反假绿）。
  it("F29-③ control: still moves that folder when every descendant projects to the translation", () => {
    const candidate = f29Candidate("converged");

    expect(candidate.status).toBe("planned");
    expect(folderMoveRows(candidate)).toContainEqual(expect.objectContaining({
      type: SyncActionType.MoveLocalFolder,
      path: "05秋招记录",
      renameFrom: "05秋招",
    }));
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

  it("treats the old path as deleted after every copy has its own identity", () => {
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
        type: SyncActionType.DeleteRemote,
        path: "old.md",
        reason: "reason.fileDeletedLocally",
      }),
    ]);
  });

  it("does not infer a deleted synced copy from another anchored file", () => {
    const committedCopies = envelope({
      files: [
        { id: "original", name: "report.md", parentId: "original-folder" },
        { id: "copy", name: "report.md", parentId: "copy-folder" },
      ],
      folders: [
        { id: "original-folder", name: "Original" },
        { id: "copy-folder", name: "Copy" },
      ],
      folderAnchors: [
        folderAnchor("original-folder", "Original"),
        folderAnchor("copy-folder", "Copy"),
      ],
      fileAnchors: [
        fileAnchor("original", "Original/report.md"),
        fileAnchor("copy", "Copy/report.md"),
      ],
    });

    const candidate = build({
      state: committedCopies,
      localFiles: [localFile("Original/report.md")],
      localFolders: localFolders("Original"),
    });

    expect(candidate.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.DeleteRemote,
        path: "Copy/report.md",
        reason: "reason.fileDeletedLocally",
      }),
      expect.objectContaining({
        type: SyncActionType.DeleteRemoteFolder,
        path: "Copy",
      }),
    ]);
  });

  it("holds a real out-of-scope move but not EasySync's own recovery copy", () => {
    const state = envelope({
      files: [{ id: "note", name: "note.md" }],
      folderAnchors: [],
      fileAnchors: [fileAnchor("note", "note.md")],
    });
    // Same shape as the live includeCanonicalFilePath: Archive/ and EasySync's
    // own bookkeeping paths are both outside the sync scope.
    const includeFilePath = (path: string): boolean =>
      !path.startsWith("Archive/")
      && !isEasySyncInternalPath(path, ".obsidian");
    const hintAt = (toPath: string) => [{
      version: 1 as const,
      scope,
      remoteId: "note",
      fromPath: "note.md",
      toPath,
      observedAt: 1,
    }];

    // The user really moved the file out of scope: the vanished old path still
    // has to hold the cloud deletion for review.
    const crossing = build({
      state,
      localFiles: [],
      localFileMoveHints: hintAt("Archive/note.md"),
      includeFilePath,
    });
    expect(crossing.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.FolderDeferred,
      path: "note.md",
      reason: "reason.file.scope-crossing",
    }));

    // A `.easy-sync-recovery` copy is EasySync's own download-replacement
    // rename, not a destination the user chose: the file never left sync, so
    // the vanished path follows the ordinary local-deletion chain.
    const selfInflicted = build({
      state,
      localFiles: [],
      localFileMoveHints: hintAt("note.md.easy-sync-recovery"),
      includeFilePath,
    });
    expect(selfInflicted.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.DeleteRemote,
        path: "note.md",
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
    configDir: ".obsidian",
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

  it("lets theme folder deletions use the ordinary delete-remote chain", () => {
    const folders = [
      { id: "obsidian", name: ".obsidian" },
      { id: "themes", name: "themes", parentId: "obsidian" },
      { id: "primary", name: "Primary", parentId: "themes" },
      { id: "plugins", name: "plugins", parentId: "obsidian" },
      { id: "dataview", name: "dataview", parentId: "plugins" },
    ];
    const state = envelope({
      folders,
      folderAnchors: [
        folderAnchor("obsidian", ".obsidian"),
        folderAnchor("themes", ".obsidian/themes", "obsidian"),
        folderAnchor("primary", ".obsidian/themes/Primary", "themes"),
        folderAnchor("plugins", ".obsidian/plugins", "obsidian"),
        folderAnchor("dataview", ".obsidian/plugins/dataview", "plugins"),
      ],
    });
    const candidate = build({ state, localFiles: [], localFolders: [] });

    const folderDeletes = candidate.items
      .filter((item) => item.type === SyncActionType.DeleteRemoteFolder)
      .map((item) => item.path)
      .sort();
    const deferred = candidate.items
      .filter((item) => item.type === SyncActionType.FolderDeferred)
      .map((item) => item.path)
      .sort();
    expect(folderDeletes).toEqual([
      ".obsidian/themes",
      ".obsidian/themes/Primary",
    ]);
    expect(deferred).toEqual([
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/dataview",
    ]);
  });

  it("lets theme folder deletions use the ordinary delete-local chain", () => {
    const folders = [
      { id: "obsidian", name: ".obsidian" },
      { id: "themes", name: "themes", parentId: "obsidian" },
      { id: "plugins", name: "plugins", parentId: "obsidian" },
    ];
    // Both sides of the theme scope were anchored; the remote no longer has
    // the theme folder (deleted on another device) while the local folder
    // still exists. Plugin folders must stay protected in the same shape.
    const state = envelope({
      folders,
      folderAnchors: [
        folderAnchor("obsidian", ".obsidian"),
        folderAnchor("themes", ".obsidian/themes", "obsidian"),
        folderAnchor("primary", ".obsidian/themes/Primary", "themes"),
        folderAnchor("plugins", ".obsidian/plugins", "obsidian"),
        folderAnchor("dataview", ".obsidian/plugins/dataview", "plugins"),
      ],
    });
    const candidate = build({
      state,
      localFiles: [],
      localFolders: localFolders(
        ".obsidian",
        ".obsidian/themes",
        ".obsidian/themes/Primary",
        ".obsidian/plugins",
        ".obsidian/plugins/dataview",
      ),
    });

    const localDeletes = candidate.items
      .filter((item) => item.type === SyncActionType.DeleteLocalFolder)
      .map((item) => item.path)
      .sort();
    const deferred = candidate.items
      .filter((item) => item.type === SyncActionType.FolderDeferred)
      .map((item) => item.path)
      .sort();
    // The themes root still exists remotely (only the theme itself was
    // deleted on another device), so only the anchored theme folder is a
    // delete-local candidate. The plugin folder stays protected.
    expect(localDeletes).toEqual([
      ".obsidian/themes/Primary",
    ]);
    expect(deferred).toEqual([
      ".obsidian/plugins/dataview",
    ]);
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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
      configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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
    configDir: ".obsidian",
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

  describe("item-fact drift knife (2026-10-09)", () => {
    const digestOf = (planItems: SyncPlanItem[], lastTotalFiles = 4) =>
      canonicalPlanDigestV2({
        items: planItems,
        lastTotalFiles,
        scope,
        sourceCommitSeq: 7,
      });
    const drift = (
      previous: SyncPlanItem[],
      next: SyncPlanItem[],
      options: {
        previousLastTotalFiles?: number;
        nextLastTotalFiles?: number;
        limit?: number;
      } = {},
    ) => describeCanonicalPlanItemFactsDriftV2({
      previousDigest: digestOf(previous, options.previousLastTotalFiles ?? 4),
      nextItems: next,
      nextDigest: digestOf(next, options.nextLastTotalFiles ?? 4),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });

    function uploadItem(path: string, hash = hashA): SyncPlanItem {
      return {
        type: SyncActionType.Upload,
        path,
        local: { path, hash, size: 10, mtime: 1, binary: false },
      };
    }

    /** One item carrying every optional fact slot the digest serializes. */
    function guardItem(): SyncPlanItem {
      return {
        type: SyncActionType.Conflict,
        path: "guard/note.md",
        reason: "reason.newFileBothSides",
        local: {
          path: "guard/note.md",
          hash: hashB,
          size: 12,
          mtime: 1,
          binary: false,
        },
        remote: {
          path: "guard/note.md",
          driveId: "guard-drive",
          parentId: "guard-parent",
          size: 12,
          mtime: 1,
          eTag: "etag-guard",
          cTag: "ctag-guard",
          sha256Hash: hashB,
          quickXorHash: "quick-guard",
        },
        folder: {
          remoteId: "guard-folder",
          parentRemoteId: "guard-folder-parent",
          parentPath: "guard",
          remoteETag: "etag-guard-folder",
          parentRemoteETag: "etag-guard-folder-parent",
          sourceParentRemoteId: "guard-source-parent",
        },
        baseEtag: "etag-guard-base",
        renameFrom: "guard/old.md",
        targetParentRemoteId: "guard-target-parent",
        requiresConfirmation: false,
        reviewImpactCount: 3,
        decisionToken: {
          version: 1,
          vaultName: "Vault",
          accountId: scope.accountId,
          scope,
          local: { exists: true, hash: hashB, size: 12 },
          remote: { exists: true, driveId: "guard-drive", eTag: "etag-guard" },
          ancestorHash: hashA,
        },
        contentComparison: {
          version: 1,
          result: "different",
          localHash: hashB,
          localSize: 12,
          remoteDriveId: "guard-drive",
          remoteETag: "etag-guard",
          remoteSize: 12,
          remoteHash: "d".repeat(64),
        },
      };
    }

    it("names the one drifted fact for every item-fact position", () => {
      const base = guardItem();
      const mutations: Array<{
        name: string;
        mutate: (item: SyncPlanItem) => void;
      }> = [
        { name: "type", mutate: (item) => {
          item.type = SyncActionType.Download;
        } },
        { name: "path", mutate: (item) => {
          item.path = "guard/moved.md";
        } },
        { name: "reason", mutate: (item) => {
          item.reason = "reason.other";
        } },
        { name: "local", mutate: (item) => {
          delete item.local;
        } },
        { name: "local.path", mutate: (item) => {
          item.local!.path = "guard/moved.md";
        } },
        { name: "local.hash", mutate: (item) => {
          item.local!.hash = hashA;
        } },
        { name: "local.size", mutate: (item) => {
          item.local!.size = 99;
        } },
        { name: "local.binary", mutate: (item) => {
          item.local!.binary = true;
        } },
        { name: "remote", mutate: (item) => {
          delete item.remote;
        } },
        { name: "remote.path", mutate: (item) => {
          item.remote!.path = "guard/moved.md";
        } },
        { name: "remote.driveId", mutate: (item) => {
          item.remote!.driveId = "other-drive";
        } },
        { name: "remote.parentId", mutate: (item) => {
          item.remote!.parentId = "other-parent";
        } },
        { name: "remote.size", mutate: (item) => {
          item.remote!.size = 99;
        } },
        { name: "remote.eTag", mutate: (item) => {
          item.remote!.eTag = "etag-other";
        } },
        { name: "remote.cTag", mutate: (item) => {
          item.remote!.cTag = "ctag-other";
        } },
        { name: "remote.sha256Hash", mutate: (item) => {
          item.remote!.sha256Hash = hashA;
        } },
        { name: "remote.quickXorHash", mutate: (item) => {
          item.remote!.quickXorHash = "quick-other";
        } },
        { name: "folder", mutate: (item) => {
          delete item.folder;
        } },
        { name: "folder.remoteId", mutate: (item) => {
          item.folder!.remoteId = "other-folder";
        } },
        { name: "folder.parentRemoteId", mutate: (item) => {
          item.folder!.parentRemoteId = "other-parent";
        } },
        { name: "folder.parentPath", mutate: (item) => {
          item.folder!.parentPath = "other";
        } },
        { name: "folder.remoteETag", mutate: (item) => {
          item.folder!.remoteETag = "etag-other";
        } },
        { name: "folder.parentRemoteETag", mutate: (item) => {
          item.folder!.parentRemoteETag = "etag-other";
        } },
        { name: "folder.sourceParentRemoteId", mutate: (item) => {
          item.folder!.sourceParentRemoteId = "other-source";
        } },
        { name: "baseEtag", mutate: (item) => {
          item.baseEtag = "etag-other";
        } },
        { name: "renameFrom", mutate: (item) => {
          delete item.renameFrom;
        } },
        { name: "targetParentRemoteId", mutate: (item) => {
          delete item.targetParentRemoteId;
        } },
        { name: "requiresConfirmation", mutate: (item) => {
          item.requiresConfirmation = true;
        } },
        { name: "reviewImpactCount", mutate: (item) => {
          item.reviewImpactCount = 4;
        } },
        { name: "decisionToken", mutate: (item) => {
          delete item.decisionToken;
        } },
        { name: "decisionToken.version", mutate: (item) => {
          (item.decisionToken as { version: number }).version = 2;
        } },
        { name: "decisionToken.vaultName", mutate: (item) => {
          item.decisionToken!.vaultName = "Other";
        } },
        { name: "decisionToken.accountId", mutate: (item) => {
          item.decisionToken!.accountId = "other-account";
        } },
        { name: "decisionToken.scope.accountId", mutate: (item) => {
          item.decisionToken!.scope.accountId = "other-account";
        } },
        { name: "decisionToken.scope.driveId", mutate: (item) => {
          item.decisionToken!.scope.driveId = "other-drive";
        } },
        { name: "decisionToken.scope.vaultFolderId", mutate: (item) => {
          item.decisionToken!.scope.vaultFolderId = "other-vault";
        } },
        { name: "decisionToken.scope.filesRootId", mutate: (item) => {
          item.decisionToken!.scope.filesRootId = "other-root";
        } },
        { name: "decisionToken.local", mutate: (item) => {
          (item.decisionToken as { local: unknown }).local = { exists: false };
        } },
        { name: "decisionToken.remote", mutate: (item) => {
          (item.decisionToken as { remote: unknown }).remote = { exists: false };
        } },
        { name: "decisionToken.ancestorHash", mutate: (item) => {
          item.decisionToken!.ancestorHash = null;
        } },
        { name: "contentComparison", mutate: (item) => {
          delete item.contentComparison;
        } },
        { name: "contentComparison.version", mutate: (item) => {
          (item.contentComparison as { version: number }).version = 2;
        } },
        { name: "contentComparison.result", mutate: (item) => {
          (item.contentComparison as { result: string }).result = "equal";
        } },
        { name: "contentComparison.localHash", mutate: (item) => {
          item.contentComparison!.localHash = hashA;
        } },
        { name: "contentComparison.localSize", mutate: (item) => {
          item.contentComparison!.localSize = 99;
        } },
        { name: "contentComparison.remoteDriveId", mutate: (item) => {
          item.contentComparison!.remoteDriveId = "other-drive";
        } },
        { name: "contentComparison.remoteETag", mutate: (item) => {
          item.contentComparison!.remoteETag = "etag-other";
        } },
        { name: "contentComparison.remoteSize", mutate: (item) => {
          item.contentComparison!.remoteSize = 99;
        } },
        { name: "contentComparison.remoteHash", mutate: (item) => {
          item.contentComparison!.remoteHash = "e".repeat(64);
        } },
      ];
      // 13 top-level positions + local 4 / remote 8 / folder 6 / token 10 /
      // comparison 8 nested positions of canonicalPlanItemFactsV2.
      expect(mutations).toHaveLength(13 + 4 + 8 + 6 + 10 + 8);
      for (const { name, mutate } of mutations) {
        const next = [structuredClone(base)];
        mutate(next[0]!);
        const report = drift([base], next);
        if (name === "type" || name === "path") {
          // The match key is (type,path): an identity change leaves the paired
          // group and appears as one removal plus one addition.
          expect(report, name).toMatchObject({
            available: true,
            changed: 0,
            added: 1,
            removed: 1,
            samplesOmitted: 0,
          });
          expect(report.samples.map((sample) => sample.kind), name)
            .toEqual(["removed", "added"]);
          continue;
        }
        expect(report, name).toMatchObject({
          available: true,
          changed: 1,
          added: 0,
          removed: 0,
          samplesOmitted: 0,
        });
        expect(report.samples, name).toEqual([{
          kind: "changed",
          type: base.type,
          path: base.path,
          fields: [name],
        }]);
      }
    });

    it("separates added from removed items and keeps them out of changed", () => {
      const kept = uploadItem("keep.md");
      const dropped = uploadItem("dropped.md");
      const fresh = uploadItem("fresh.md");
      const report = drift([kept, dropped], [kept, fresh]);

      expect(report).toMatchObject({
        available: true,
        reason: null,
        changed: 0,
        added: 1,
        removed: 1,
        samplesOmitted: 0,
        outsideReviewFields: false,
      });
      expect(report.items).toEqual({ previous: 2, next: 2 });
      expect(report.lastTotalFiles).toEqual({ previous: 4, next: 4 });
      expect(report.samples).toEqual([
        {
          kind: "removed",
          type: SyncActionType.Upload,
          path: "dropped.md",
          fields: [],
        },
        {
          kind: "added",
          type: SyncActionType.Upload,
          path: "fresh.md",
          fields: [],
        },
      ]);
    });

    it("bounds samples at ten by default and reports the omitted rest", () => {
      const before = Array.from(
        { length: 12 },
        (_, index) => uploadItem(`note-${index}.md`),
      );
      const after = before.map((item) => ({
        ...item,
        local: { ...item.local!, hash: hashB },
      }));

      const capped = drift(before, after);
      expect(capped).toMatchObject({ changed: 12, samplesOmitted: 2 });
      expect(capped.samples).toHaveLength(10);
      expect(capped.samples[0]?.path).toBe("note-0.md");

      const explicit = drift(before, after, { limit: 3 });
      expect(explicit).toMatchObject({ changed: 12, samplesOmitted: 9 });
      expect(explicit.samples).toHaveLength(3);
      expect(explicit.samples.map((sample) => sample.path))
        .toEqual(["note-0.md", "note-1.md", "note-2.md"]);
    });

    it("reports the specific drift that the review projection cannot show", () => {
      const base = guardItem();
      const tokenOnly = [structuredClone(base)];
      tokenOnly[0]!.decisionToken!.ancestorHash = null;
      expect(drift([base], tokenOnly)).toMatchObject({
        available: true,
        changed: 1,
        outsideReviewFields: true,
        samples: [{
          kind: "changed",
          path: base.path,
          fields: ["decisionToken.ancestorHash"],
        }],
      });

      const receiptOnly = [structuredClone(base)];
      receiptOnly[0]!.contentComparison!.remoteHash = "e".repeat(64);
      expect(drift([base], receiptOnly)).toMatchObject({
        outsideReviewFields: true,
        samples: [{ fields: ["contentComparison.remoteHash"] }],
      });

      const visibleOnly = [structuredClone(base)];
      visibleOnly[0]!.local!.hash = hashA;
      expect(drift([base], visibleOnly)).toMatchObject({
        outsideReviewFields: false,
        samples: [{ fields: ["local.hash"] }],
      });
    });

    it("never puts fact values into the report", () => {
      const base = guardItem();
      const next = [structuredClone(base)];
      next[0]!.local!.hash = "f".repeat(64);
      next[0]!.remote!.cTag = "ctag-leak-probe";
      const report = drift([base], next);

      expect(report.samples).toEqual([{
        kind: "changed",
        type: base.type,
        path: base.path,
        fields: ["local.hash", "remote.cTag"],
      }]);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("f".repeat(64));
      expect(serialized).not.toContain("ctag-leak-probe");
    });

    it("reports lastTotalFiles drift on its own", () => {
      const items = [uploadItem("note.md")];
      const report = describeCanonicalPlanItemFactsDriftV2({
        previousDigest: digestOf(items, 4),
        nextItems: items,
        nextDigest: digestOf(items, 9),
      });

      expect(report).toMatchObject({
        available: true,
        changed: 0,
        added: 0,
        removed: 0,
        samplesOmitted: 0,
      });
      expect(report.samples).toEqual([]);
      expect(report.items).toEqual({ previous: 1, next: 1 });
      expect(report.lastTotalFiles).toEqual({ previous: 4, next: 9 });
    });

    it("keeps every failure reason non-throwing on an unreadable digest", () => {
      const items = [uploadItem("note.md")];
      const valid = digestOf(items);
      const next = [uploadItem("note.md")];
      const nextDigest = digestOf(next);
      const failure = {
        available: false,
        items: null,
        lastTotalFiles: null,
        changed: 0,
        added: 0,
        removed: 0,
        samples: [],
        samplesOmitted: 0,
        outsideReviewFields: false,
      };

      expect(describeCanonicalPlanItemFactsDriftV2({
        previousDigest: "not json",
        nextItems: next,
        nextDigest,
      })).toEqual({ ...failure, reason: "unparsable" });
      expect(describeCanonicalPlanItemFactsDriftV2({
        previousDigest: valid,
        nextItems: next,
        nextDigest: "{oops",
      })).toEqual({ ...failure, reason: "unparsable" });
      for (const malformed of [
        JSON.stringify([1, 2, 3]),
        JSON.stringify({ version: 3, items: [] }),
        JSON.stringify({
          version: 2,
          sourceCommitSeq: 7,
          scope: ["a", "b", "c"],
          lastTotalFiles: 1,
          items: [],
        }),
        JSON.stringify({
          version: 2,
          sourceCommitSeq: 7,
          scope: ["a", "b", "c", "d"],
          lastTotalFiles: 1,
          items: [["upload", "note.md"]],
        }),
        JSON.stringify({
          version: 2,
          sourceCommitSeq: 7,
          scope: ["a", "b", "c", "d"],
          lastTotalFiles: 1.5,
          items: [],
        }),
      ]) {
        expect(describeCanonicalPlanItemFactsDriftV2({
          previousDigest: malformed,
          nextItems: next,
          nextDigest,
        })).toEqual({ ...failure, reason: "shape-mismatch" });
      }
      expect(describeCanonicalPlanItemFactsDriftV2({
        previousDigest: valid,
        nextItems: next,
        nextDigest: digestOf([uploadItem("other.md")]),
      })).toEqual({ ...failure, reason: "sealed-plan-not-reproducible" });
    });
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

  describe("knife-1 verification downloadUrl refresh (2026-09-08)", () => {
    function hashlessConflictState(count: number): SyncStateEnvelopeV2 {
      const files = Array.from({ length: count }, (_, index) => ({
        id: `conflict-${index}`,
        name: `conflict-${index}.md`,
      }));
      const state = envelope({
        files,
        folderAnchors: [],
        fileAnchors: files.map((file) =>
          fileAnchor(file.id, file.name)),
      });
      for (const file of files) {
        delete state.remoteIndex.itemsById[file.id]!.contentHash;
        state.remoteIndex.itemsById[file.id]!.eTag = `etag-new-${file.id}`;
      }
      return state;
    }

    it("batches a single refresh call over exactly the budgeted verification download set before any download", async () => {
      const state = hashlessConflictState(3);
      const candidate = build({
        state,
        localFiles: [
          localFile("conflict-0.md", hashB),
          localFile("conflict-1.md", hashB),
          localFile("conflict-2.md", hashB),
        ],
      });
      const refreshedPaths: string[] = [];
      const resolverSeenUrls: Array<string | undefined> = [];
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
        refreshVerificationDownloadUrls: async (items) => {
          for (const item of items) {
            refreshedPaths.push(item.path);
            if (item.remote) {
              item.remote.downloadUrl = `https://dl.example/${item.remote.driveId}`;
            }
          }
        },
        resolveRemoteContentHash: async (item) => {
          resolverSeenUrls.push(item.remote?.downloadUrl);
          return "c".repeat(64);
        },
      configDir: ".obsidian",
      });

      expect(refreshedPaths).toEqual([
        "conflict-0.md",
        "conflict-1.md",
        "conflict-2.md",
      ]);
      // Every verification download must reuse the planner-stage refresh URL
      // instead of paying a per-file metadata round trip.
      expect(resolverSeenUrls).toEqual([
        "https://dl.example/conflict-0",
        "https://dl.example/conflict-1",
        "https://dl.example/conflict-2",
      ]);
      expect(finalized.contentVerification).toMatchObject({
        candidates: 3,
        cachedEvidence: 0,
        downloads: 3,
        skippedDownloads: 0,
      });
    });

    it("stays fail-open when the refresh hook throws or fills nothing", async () => {
      const state = hashlessConflictState(2);
      const candidate = build({
        state,
        localFiles: [
          localFile("conflict-0.md", hashB),
          localFile("conflict-1.md", hashB),
        ],
      });
      let downloads = 0;
      const failed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        refreshVerificationDownloadUrls: async () => {
          throw new Error("batch refresh offline");
        },
        resolveRemoteContentHash: async () => {
          downloads++;
          return "c".repeat(64);
        },
      configDir: ".obsidian",
      });
      expect(downloads).toBe(2);
      expect(failed.contentVerification.results.every(
        (item) => item.outcome === "different",
      )).toBe(true);
    });

    it("respects the shared download budget: only budgeted candidates are refreshed", async () => {
      const state = hashlessConflictState(4);
      const candidate = build({
        state,
        localFiles: Array.from({ length: 4 }, (_, index) =>
          localFile(`conflict-${index}.md`, hashB)),
      });
      let budgetSeen = 0;
      await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        refreshVerificationDownloadUrls: async (items) => {
          budgetSeen += items.length;
        },
        resolveRemoteContentHash: async () => "c".repeat(64),
      configDir: ".obsidian",
      });
      // Four candidates minus zero cached evidence fit inside the ordinary
      // round budget of 10, so the refresh must see all four exactly once.
      expect(budgetSeen).toBe(4);
    });
  });

  describe("knife-2 verification download window (2026-09-08)", () => {
    function hashlessConflictState(count: number): SyncStateEnvelopeV2 {
      const files = Array.from({ length: count }, (_, index) => ({
        id: `conflict-${index}`,
        name: `conflict-${index}.md`,
      }));
      const state = envelope({
        files,
        folderAnchors: [],
        fileAnchors: files.map((file) =>
          fileAnchor(file.id, file.name)),
      });
      for (const file of files) {
        delete state.remoteIndex.itemsById[file.id]!.contentHash;
        state.remoteIndex.itemsById[file.id]!.eTag = `etag-new-${file.id}`;
      }
      return state;
    }

    function buildState(count: number) {
      const state = hashlessConflictState(count);
      const candidate = build({
        state,
        localFiles: Array.from({ length: count }, (_, index) =>
          localFile(`conflict-${index}.md`, hashB)),
      });
      return { state, candidate };
    }

    it("overlaps verification content downloads inside a bounded window without changing any outcome", async () => {
      const { state, candidate } = buildState(3);
      let inFlight = 0;
      let peakInFlight = 0;
      const resolver = async (_item: SyncPlanItem, _progress: {
        current: number;
        total: number;
      }): Promise<string> => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return "c".repeat(64);
      };
      const serial = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: resolver,
      configDir: ".obsidian",
      });
      expect(peakInFlight).toBe(1);

      peakInFlight = 0;
      const windowed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        verificationDownloadWindow: {
          maxFiles: 2,
          maxBytes: 1024 * 1024 * 64,
        },
        resolveRemoteContentHash: resolver,
      configDir: ".obsidian",
      });
      expect(peakInFlight).toBe(2);

      // Windows must not change any observable outcome: identical items,
      // base upserts, receipts, and verification results in the same order.
      expect(windowed.items).toEqual(serial.items);
      expect(windowed.baseUpserts).toEqual(serial.baseUpserts);
      expect(windowed.contentVerification).toEqual(
        serial.contentVerification,
      );
    });

    it("keeps per-item failure isolation inside a window", async () => {
      const { state, candidate } = buildState(3);
      const resolver = async (item: SyncPlanItem): Promise<string> => {
        if (item.path === "conflict-1.md") {
          throw new Error("offline for one candidate");
        }
        return "c".repeat(64);
      };
      const serial = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        resolveRemoteContentHash: resolver,
      configDir: ".obsidian",
      });
      const windowed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        verificationDownloadWindow: {
          maxFiles: 2,
          maxBytes: 1024 * 1024 * 64,
        },
        resolveRemoteContentHash: resolver,
      configDir: ".obsidian",
      });
      expect(windowed.items).toEqual(serial.items);
      expect(windowed.contentVerification.results).toEqual(
        serial.contentVerification.results,
      );
      expect(windowed.contentVerification.results).toContainEqual(
        expect.objectContaining({
          path: "conflict-1.md",
          outcome: "failed",
        }),
      );
    });

    it("keeps the shared download budget under a window", async () => {
      const { state, candidate } = buildState(11);
      let downloads = 0;
      const finalize = (windowed: boolean) =>
        finalizeCanonicalPlanCandidateV2({
          candidate,
          envelope: state,
          vaultName: "Vault",
          accountId: scope.accountId,
          automaticHandlingPolicy: {
            autoDeleteLocalFiles: false,
            mergeNonOverlappingText: true,
          },
          baselineReconstructionIncomplete: false,
          verificationDownloadWindow: windowed
            ? { maxFiles: 4, maxBytes: 1024 * 1024 * 64 }
            : undefined,
          resolveRemoteContentHash: async () => {
            downloads++;
            return "c".repeat(64);
          },
        configDir: ".obsidian",
        });
      const serial = await finalize(false);
      expect(downloads).toBe(10);
      downloads = 0;
      const windowed = await finalize(true);
      expect(downloads).toBe(10);
      expect(windowed.items).toEqual(serial.items);
      expect(windowed.baseUpserts).toEqual(serial.baseUpserts);
      expect(windowed.contentVerification).toEqual(serial.contentVerification);
    });

    it("adversarial: the byte budget alone degrades oversized windows to serial", async () => {
      const { state, candidate } = buildState(3);
      let inFlight = 0;
      let peakInFlight = 0;
      const resolver = async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return "c".repeat(64);
      };
      const windowed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        // maxFiles allows batching, but every non-first member overflows the
        // tiny byte budget: the window must degrade per-file (peak 1) and
        // still produce the exact serial outcome.
        verificationDownloadWindow: {
          maxFiles: 100,
          maxBytes: 1,
        },
        resolveRemoteContentHash: resolver,
        configDir: ".obsidian",
      });
      expect(peakInFlight).toBe(1);
      expect(windowed.contentVerification.results).toHaveLength(3);
    });

    it("adversarial: prefetch progress stays monotonic across window flushes", async () => {
      const { state, candidate } = buildState(5);
      const seen: number[] = [];
      const resolver = async (
        _item: SyncPlanItem,
        progress: { current: number; total: number },
      ): Promise<string> => {
        seen.push(progress.current);
        expect(progress.current).toBeLessThanOrEqual(progress.total);
        expect(progress.total).toBeGreaterThanOrEqual(1);
        return "c".repeat(64);
      };
      const windowed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        verificationDownloadWindow: {
          maxFiles: 2,
          maxBytes: 1024 * 1024 * 64,
        },
        resolveRemoteContentHash: resolver,
        configDir: ".obsidian",
      });
      // Progress must never reset at a flush boundary (a stale per-window
      // counter would emit e.g. 1,2,1,2 — red side of this adversarial test).
      let previous = 0;
      for (const current of seen) {
        expect(current).toBeGreaterThan(previous);
        previous = current;
      }
      expect(seen.length).toBeGreaterThan(1);
      expect(windowed.contentVerification.results).toHaveLength(seen.length);
    });

    it("adversarial: an offline refresh hook stays fail-open under a download window", async () => {
      const { state, candidate } = buildState(3);
      let inFlight = 0;
      let peakInFlight = 0;
      const windowed = await finalizeCanonicalPlanCandidateV2({
        candidate,
        envelope: state,
        vaultName: "Vault",
        accountId: scope.accountId,
        automaticHandlingPolicy: {
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: true,
        },
        baselineReconstructionIncomplete: false,
        refreshVerificationDownloadUrls: async () => {
          throw new Error("batch refresh offline");
        },
        verificationDownloadWindow: {
          maxFiles: 2,
          maxBytes: 1024 * 1024 * 64,
        },
        resolveRemoteContentHash: async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
          return "c".repeat(64);
        },
        configDir: ".obsidian",
      });
      // Hook fail-open and window overlap are independent contracts: the
      // offline hook must not disable the window (still peak 2), and the
      // verification outcome must stay complete with no failed rows.
      expect(peakInFlight).toBe(2);
      expect(windowed.contentVerification.results).toHaveLength(3);
      expect(windowed.contentVerification.results.every(
        (item) => item.outcome !== "failed",
      )).toBe(true);
    });
  });
});

describe("canonical plan large-file gate wiring", () => {
  it("forwards the device size threshold into the file decision facts", () => {
    const source = readFileSync("src/sync/canonical-plan-v2.ts", "utf8");
    expect(source).toContain("maxFileSizeBytes: input.maxFileSizeBytes,");
  });

  it("threads the scanner threshold at every canonical facts build site", () => {
    const source = readFileSync("src/sync/sync-executor.ts", "utf8");
    const field = "maxFileSizeBytes: this.scanner.getMaxFileSize?.(),";
    // 保留原并集断言（任一处接线），逐点断言见下。
    expect(source).toContain(field);

    // 收窄取证：原断言是文件级并集，六处接线里删掉任意一处仍绿。
    // 逐点钉＝要求字段落在该 builder 调用的对象字面量内，缺一处即红。
    const pinSite = (builder: string, terminator: string, from = 0): number => {
      const start = source.indexOf(builder, from);
      expect(start, `missing canonical facts build site: ${builder}`).toBeGreaterThan(-1);
      const end = source.indexOf(terminator, start + builder.length);
      expect(end, `missing call terminator after: ${builder}`).toBeGreaterThan(start);
      expect(
        source.slice(start, end),
        `scanner threshold not threaded at: ${builder}`,
      ).toContain(field);
      return end;
    };

    // 1. 失效身份解析快照（buildCurrentStaleIdentityResolutionReview）。
    pinSite(
      "    const snapshot = buildStaleIdentityResolutionSnapshotV1(",
      "\n    );",
    );
    // 2. V2 计划重建闭包（runStep5PrepareCanonicalPlanCandidate）。
    pinSite(
      "      buildCanonicalPlanCandidateV2({",
      "\n      });",
    );
    // 3. 迁移候选状态（同一方法内的第二个构建点）。
    pinSite(
      "      canonicalPlanCandidate = buildCanonicalPlanCandidateFromStateV2({",
      "\n      });",
    );
    // 4／5. 两条 V2 恢复路径各自从已提交信封重建计划。
    const corruptStateSite = pinSite(
      "    let canonical = buildCanonicalPlanCandidateV2({",
      "\n    });",
    );
    pinSite(
      "    let canonical = buildCanonicalPlanCandidateV2({",
      "\n    });",
      corruptStateSite,
    );
    // 6. 文件夹移动续跑候选（continuationCandidate）；本处原先漏接线，
    // 逐点钉后补上，续跑轮与普通轮共用同一大文件下载门。
    pinSite(
      "      ? buildCanonicalPlanCandidateV2({",
      "\n        })",
    );

    // 数量钉住：防止新增接线点只改标题不补断言，或某处字段被别名绕开。
    expect(source.split(field)).toHaveLength(7);
  });
});
