import { describe, expect, it } from "vitest";
import {
  generateFileDecisionPlanV2,
  hasOneDriveInvalidNamePath,
  protectEasySyncSelfSyncPlan,
  type FileDecisionFactsV2,
} from "../src/sync/file-decision-planner-v2";
import {
  shouldPauseCanonicalPlanForReviewV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import {
  type BaseFileEntry,
  type LocalFileEntry,
  type RemoteFileEntry,
  SyncActionType,
  type SyncPlan,
} from "../src/sync/types";

function local(
  path: string,
  hash = "11".repeat(32),
  size = 11,
): LocalFileEntry {
  return { path, hash, size, mtime: 10, binary: false };
}

function remote(
  path: string,
  overrides: Partial<RemoteFileEntry> = {},
): RemoteFileEntry {
  return {
    path,
    driveId: `remote-${path}`,
    parentId: "files-root",
    size: 11,
    mtime: 20,
    eTag: "etag-base",
    cTag: "ctag-base",
    ...overrides,
  };
}

function base(
  path: string,
  overrides: Partial<BaseFileEntry> = {},
): BaseFileEntry {
  return {
    path,
    hash: "11".repeat(32),
    size: 11,
    eTag: "etag-base",
    ...overrides,
  };
}

describe("V2 pure file decision planner", () => {
  it.each([
    { changed: false, originalType: SyncActionType.ConfirmLocalDelete },
    { changed: true, originalType: SyncActionType.Conflict },
  ])("restores a remote-missing EasySync build instead of authorizing local deletion", ({
    changed,
    originalType,
  }) => {
    const path = ".obsidian/plugins/easy-sync/main.js";
    const localEntry = local(path, changed ? "22".repeat(32) : undefined);
    const generated = generateFileDecisionPlanV2({
      localEntries: [localEntry],
      remoteEntries: [],
      baseEntries: [base(path)],
      skippedLarge: [],
    configDir: ".obsidian",
    });

    expect(generated.items).toEqual([
      expect.objectContaining({ type: originalType, path }),
    ]);
    expect(protectEasySyncSelfSyncPlan(
      generated.items,
      ".obsidian",
    )).toEqual([{
      type: SyncActionType.Upload,
      path,
      local: localEntry,
    }]);
  });

  const classificationCases: Array<{
    name: string;
    facts: FileDecisionFactsV2;
    expected: Array<{
      type: SyncActionType;
      path: string;
      reason?: string;
      baseEtag?: string;
      carriesLocal?: boolean;
    }>;
  }> = [
    {
      name: "new local file uploads",
      facts: {
        localEntries: [local("local.md")],
        remoteEntries: [],
        baseEntries: [],
        skippedLarge: [],
      },
      expected: [{ type: SyncActionType.Upload, path: "local.md" }],
    },
    {
      name: "new remote file downloads",
      facts: {
        localEntries: [],
        remoteEntries: [remote("remote.md")],
        baseEntries: [],
        skippedLarge: [],
      },
      expected: [{ type: SyncActionType.Download, path: "remote.md" }],
    },
    {
      name: "two unanchored versions conflict",
      facts: {
        localEntries: [local("both.md")],
        remoteEntries: [remote("both.md")],
        baseEntries: [],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Conflict,
        path: "both.md",
        reason: "reason.newFileBothSides",
      }],
    },
    {
      name: "local-only modification uploads with remote CAS",
      facts: {
        localEntries: [local("local-change.md", "22".repeat(32), 12)],
        remoteEntries: [remote("local-change.md")],
        baseEntries: [base("local-change.md")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Upload,
        path: "local-change.md",
        baseEtag: "etag-base",
      }],
    },
    {
      name: "remote-only modification downloads with local CAS",
      facts: {
        localEntries: [local("remote-change.md")],
        remoteEntries: [remote("remote-change.md", { eTag: "etag-new" })],
        baseEntries: [base("remote-change.md")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Download,
        path: "remote-change.md",
        carriesLocal: true,
      }],
    },
    {
      name: "two anchored modifications conflict",
      facts: {
        localEntries: [local("conflict.md", "22".repeat(32), 12)],
        remoteEntries: [remote("conflict.md", { eTag: "etag-new" })],
        baseEntries: [base("conflict.md")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Conflict,
        path: "conflict.md",
        reason: "reason.bothSidesModified",
      }],
    },
    {
      name: "local deletion removes an unchanged remote file",
      facts: {
        localEntries: [],
        remoteEntries: [remote("delete-remote.md")],
        baseEntries: [base("delete-remote.md")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.DeleteRemote,
        path: "delete-remote.md",
        reason: "reason.fileDeletedLocally",
      }],
    },
    {
      name: "remote deletion waits for local confirmation",
      facts: {
        localEntries: [local("delete-local.md")],
        remoteEntries: [],
        baseEntries: [base("delete-local.md")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.ConfirmLocalDelete,
        path: "delete-local.md",
        reason: "reason.fileDeletedFromRemote",
      }],
    },
    {
      name: "managed config is restored instead of deleted",
      facts: {
        localEntries: [local(".obsidian/app.json")],
        remoteEntries: [],
        baseEntries: [base(".obsidian/app.json")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Upload,
        path: ".obsidian/app.json",
      }],
    },
    {
      name: "a bookmark snapshot missed by the scan restores from the cloud instead of deleting it",
      facts: {
        localEntries: [],
        remoteEntries: [remote(".obsidian/bookmarks.json")],
        baseEntries: [base(".obsidian/bookmarks.json")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Download,
        path: ".obsidian/bookmarks.json",
      }],
    },
    {
      name: "a bookmark file with a missing remote copy re-uploads instead of awaiting deletion",
      facts: {
        localEntries: [local(".obsidian/bookmarks.json")],
        remoteEntries: [],
        baseEntries: [base(".obsidian/bookmarks.json")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.Upload,
        path: ".obsidian/bookmarks.json",
      }],
    },
    {
      name: "oversized files are skipped instead of deleted",
      facts: {
        localEntries: [],
        remoteEntries: [remote("large.bin")],
        baseEntries: [base("large.bin")],
        skippedLarge: ["large.bin"],
      },
      expected: [{
        type: SyncActionType.SkipLargeFile,
        path: "large.bin",
        reason: "reason.fileExceedsSizeLimit",
      }],
    },
    {
      name: "new local files with names OneDrive can never store are skipped visibly",
      facts: {
        localEntries: [local("第25课：Do the English speak english?.md")],
        remoteEntries: [],
        baseEntries: [],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.SkipOneDriveInvalidName,
        path: "第25课：Do the English speak english?.md",
        reason: "reason.fileNameNotSyncable",
      }],
    },
    {
      name: "an existing OneDrive-invalid local path never uploads over a changed base",
      facts: {
        localEntries: [local("trailing-dot-name.", "33".repeat(32), 12)],
        remoteEntries: [],
        baseEntries: [base("trailing-dot-name.")],
        skippedLarge: [],
      },
      expected: [{
        type: SyncActionType.SkipOneDriveInvalidName,
        path: "trailing-dot-name.",
        reason: "reason.fileNameNotSyncable",
      }],
    },
  ];

  it.each(classificationCases)("$name", ({ facts, expected }) => {
    const before = structuredClone(facts);
    const plan = generateFileDecisionPlanV2({
      ...facts,
      configDir: ".obsidian",
    });

    expect(plan.items).toHaveLength(expected.length);
    expected.forEach((item, index) => {
      expect(plan.items[index]).toMatchObject({
        type: item.type,
        path: item.path,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.baseEtag ? { baseEtag: item.baseEtag } : {}),
      });
      if (item.carriesLocal) {
        expect(plan.items[index].local).toEqual(facts.localEntries[0]);
      }
    });
    expect(facts).toEqual(before);
  });

  it("preserves unique same-directory identity and protects ambiguous relocation", () => {
    const renameFacts: FileDecisionFactsV2 = {
      localEntries: [local("notes/new.md")],
      remoteEntries: [remote("notes/old.md")],
      baseEntries: [base("notes/old.md")],
      skippedLarge: [],
    };
    const ambiguousFacts: FileDecisionFactsV2 = {
      ...renameFacts,
      localEntries: [
        local("notes/copy-a.md"),
        local("notes/copy-b.md"),
      ],
    };

    expect(generateFileDecisionPlanV2({
      ...renameFacts,
      configDir: ".obsidian",
    }).items).toEqual([
      expect.objectContaining({
        type: SyncActionType.RenameRemote,
        path: "notes/new.md",
        renameFrom: "notes/old.md",
      }),
    ]);
    expect(generateFileDecisionPlanV2({
      ...ambiguousFacts,
      configDir: ".obsidian",
    }).items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "notes/copy-a.md",
      }),
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: "notes/copy-b.md",
      }),
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: "notes/old.md",
        reason: "reason.renameIdentityAmbiguous",
      }),
    ]);
  });

  it("keeps a rename whose target OneDrive can never store as a visible skip", () => {
    const plan = generateFileDecisionPlanV2({
      localEntries: [local("notes/new?.md")],
      remoteEntries: [remote("notes/old.md")],
      baseEntries: [base("notes/old.md")],
      skippedLarge: [],
    configDir: ".obsidian",
    });

    // The remote old path stays a marked rename source, so it is never
    // planned as a local deletion; only the visible skip is produced.
    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.SkipOneDriveInvalidName,
        path: "notes/new?.md",
        reason: "reason.fileNameNotSyncable",
      }),
    ]);
  });

  it("detects OneDrive-invalid names per path segment", () => {
    expect(hasOneDriveInvalidNamePath("ok.md")).toBe(false);
    expect(hasOneDriveInvalidNamePath("dir/ok.md")).toBe(false);
    expect(hasOneDriveInvalidNamePath("dir?/ok.md")).toBe(true);
    expect(hasOneDriveInvalidNamePath("ok?.md")).toBe(true);
    expect(hasOneDriveInvalidNamePath("trailing-dot.")).toBe(true);
    expect(hasOneDriveInvalidNamePath("trailing-space ")).toBe(true);
  });

  it("keeps safe action ordering in the pure planner", () => {
    const plan = generateFileDecisionPlanV2({
      localEntries: [
        local("upload.md", "33".repeat(32)),
        local("confirm.md"),
        local("conflict.md", "22".repeat(32), 12),
      ],
      remoteEntries: [
        remote("delete.md"),
        remote("conflict.md", { eTag: "etag-new" }),
      ],
      baseEntries: [
        base("delete.md"),
        base("confirm.md"),
        base("conflict.md"),
      ],
      skippedLarge: ["large.bin"],
    configDir: ".obsidian",
    });

    expect(plan.items.map((item) => item.type)).toEqual([
      SyncActionType.Upload,
      SyncActionType.SkipLargeFile,
      SyncActionType.Conflict,
      SyncActionType.ConfirmLocalDelete,
      SyncActionType.DeleteRemote,
    ]);
  });

  it("owns the existing change-threshold decision without counting review-only items", () => {
    const belowThreshold: SyncPlan = {
      items: [{ type: SyncActionType.Upload, path: "one.md" }],
      lastTotalFiles: 2,
      confirmed: false,
    };
    const aboveThreshold: SyncPlan = {
      items: [
        { type: SyncActionType.Upload, path: "one.md" },
        { type: SyncActionType.Download, path: "two.md" },
        { type: SyncActionType.Conflict, path: "review.md" },
      ],
      lastTotalFiles: 2,
      confirmed: false,
    };

    expect(shouldPauseCanonicalPlanForReviewV2(
      summarizeCanonicalPlanReviewV2(belowThreshold.items).impactCount,
      belowThreshold.lastTotalFiles,
    )).toBe(false);
    expect(shouldPauseCanonicalPlanForReviewV2(
      summarizeCanonicalPlanReviewV2(aboveThreshold.items).impactCount,
      aboveThreshold.lastTotalFiles,
    )).toBe(true);
  });
});

describe("V2 planner download-side large-file gate", () => {
  const MB = 1024 * 1024;

  function remoteOnlyFacts(
    remoteEntry: RemoteFileEntry,
    maxFileSizeBytes: number | undefined,
  ): FileDecisionFactsV2 {
    return {
      localEntries: [],
      remoteEntries: [remoteEntry],
      baseEntries: [],
      skippedLarge: [],
      configDir: ".obsidian",
      ...(maxFileSizeBytes === undefined
        ? {}
        : { maxFileSizeBytes }),
    };
  }

  it("skips downloading a remote-only file above the size limit instead of planning a download", () => {
    const plan = generateFileDecisionPlanV2(
      remoteOnlyFacts(remote("video.mp4", { size: 300 * MB }), 200 * MB),
    );

    expect(plan.items).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "video.mp4", reason: "reason.fileExceedsSizeLimit" },
    ]);
    expect(plan.items.some((item) => item.type === SyncActionType.Download)).toBe(false);
  });

  it("still downloads when the remote size is missing or when no limit applies (fail-open)", () => {
    const missingSize = generateFileDecisionPlanV2(
      remoteOnlyFacts(
        remote("video.mp4", { size: undefined as unknown as number }),
        200 * MB,
      ),
    );
    const unlimited = generateFileDecisionPlanV2(
      remoteOnlyFacts(remote("video.mp4", { size: 300 * MB }), Number.POSITIVE_INFINITY),
    );
    const noFactsField = generateFileDecisionPlanV2(
      remoteOnlyFacts(remote("video.mp4", { size: 300 * MB }), undefined),
    );

    for (const plan of [missingSize, unlimited, noFactsField]) {
      expect(plan.items).toEqual([
        expect.objectContaining({ type: SyncActionType.Download, path: "video.mp4" }),
      ]);
    }
  });

  it("treats a file exactly at the limit as syncable (strictly-greater threshold)", () => {
    const plan = generateFileDecisionPlanV2(
      remoteOnlyFacts(remote("video.mp4", { size: 200 * MB }), 200 * MB),
    );

    expect(plan.items).toEqual([
      expect.objectContaining({ type: SyncActionType.Download, path: "video.mp4" }),
    ]);
  });

  it("returns a previously skipped file to the download plan when the threshold is raised", () => {
    // 2026-09-16 用户问询钉测：排除必须可逆——跳过零状态写入（无 base、无
    // 墓碑），阈值放宽后同一远端文件在下轮规划中自动回到普通下载。
    const sameRemote = () => remote("video.mp4", { size: 300 * MB });

    expect(generateFileDecisionPlanV2(remoteOnlyFacts(sameRemote(), 200 * MB)).items[0].type)
      .toBe(SyncActionType.SkipLargeFile);
    expect(generateFileDecisionPlanV2(remoteOnlyFacts(sameRemote(), 512 * MB)).items[0].type)
      .toBe(SyncActionType.Download);
    expect(generateFileDecisionPlanV2(remoteOnlyFacts(sameRemote(), Number.POSITIVE_INFINITY)).items[0].type)
      .toBe(SyncActionType.Download);
  });

  it("gates the remote-update download branch but leaves deletion and conflict decisions untouched", () => {
    const oversizedRemote = { size: 300 * MB, eTag: "etag-new", cTag: "ctag-new" };

    // Remote changed while a smaller local copy exists: previously a download.
    const updatePlan = generateFileDecisionPlanV2({
      localEntries: [local("doc.mp4", "11".repeat(32), 100 * MB)],
      remoteEntries: [remote("doc.mp4", oversizedRemote)],
      baseEntries: [base("doc.mp4", { size: 100 * MB })],
      skippedLarge: [],
      configDir: ".obsidian",
      maxFileSizeBytes: 200 * MB,
    });
    expect(updatePlan.items).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "doc.mp4", reason: "reason.fileExceedsSizeLimit" },
    ]);

    // Local deletion of a previously synced oversized file must still propagate
    // as a remote deletion — the download gate must never freeze deletions.
    const deletePlan = generateFileDecisionPlanV2({
      localEntries: [],
      remoteEntries: [remote("doc.mp4", { size: 300 * MB })],
      baseEntries: [base("doc.mp4", { size: 300 * MB })],
      skippedLarge: [],
      configDir: ".obsidian",
      maxFileSizeBytes: 200 * MB,
    });
    expect(deletePlan.items).toEqual([
      expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "doc.mp4" }),
    ]);

    // Remote changed after local deletion stays a conflict (explicit user call).
    const conflictPlan = generateFileDecisionPlanV2({
      localEntries: [],
      remoteEntries: [remote("doc.mp4", oversizedRemote)],
      baseEntries: [base("doc.mp4", { size: 100 * MB })],
      skippedLarge: [],
      configDir: ".obsidian",
      maxFileSizeBytes: 200 * MB,
    });
    expect(conflictPlan.items).toEqual([
      expect.objectContaining({ type: SyncActionType.Conflict, path: "doc.mp4" }),
    ]);
  });
});
