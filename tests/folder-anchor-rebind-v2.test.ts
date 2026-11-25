import { describe, expect, it } from "vitest";
import {
  FolderAnchorRebindError,
  rebindPathIdentityFolderAnchorsV2,
} from "../src/sync/folder-anchor-rebind-v2";
import { validateEnvelope, type SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type { RemoteFolderEntry, SyncScope } from "../src/sync/types";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";
import { TEST_SYNC_SCOPE } from "./helpers/sync-safety-harness";

const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const completedAt = 100;

function folder(
  path: string,
  parentPath: string | null,
): RemoteFolderEntry {
  return {
    path,
    driveId: path,
    parentId: parentPath ?? scope.filesRootId,
    name: path.slice(path.lastIndexOf("/") + 1),
  };
}

function envelopeWithFolders(
  remoteFolders: RemoteFolderEntry[],
  options: {
    baseEntries?: Array<{ path: string; hash: string; size: number; eTag: string }>;
    remoteFiles?: Array<{ path: string; parentId: string; eTag: string }>;
  } = {},
): SyncStateEnvelopeV2 {
  const envelope = createFileStateShadowEnvelopeV2({
    scope,
    lifecycleEpoch: 1,
    commitSeq: 3,
    committedAt: 1,
    remoteEntries: (options.remoteFiles ?? []).map((entry) => ({
      path: entry.path,
      driveId: entry.path,
      parentId: entry.parentId,
      size: 1,
      mtime: 1,
      eTag: entry.eTag,
      cTag: entry.eTag,
    })),
    remoteFolders,
    baseEntries: options.baseEntries ?? [],
  });
  const anchors = {
    schemaVersion: 2 as const,
    byAnchorId: {
      "folder:docs": {
        anchorId: "folder:docs",
        remoteId: "docs",
        lastPath: "docs",
        parentRemoteId: scope.filesRootId,
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
      "folder:docs/sub": {
        anchorId: "folder:docs/sub",
        remoteId: "docs/sub",
        lastPath: "docs/sub",
        parentRemoteId: "docs",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    },
  };
  const withAnchors = { ...envelope, folderAnchors: anchors };
  validateEnvelope(withAnchors);
  return withAnchors;
}

describe("路径身份 folder anchor 重绑", () => {
  it("把源子树 folder anchor 翻译到目标路径并把 remoteId 改成目标路径", () => {
    const envelope = envelopeWithFolders([
      folder("docs", null),
      folder("docs/sub", "docs"),
      folder("renamed", null),
      folder("renamed/sub", "renamed"),
    ]);

    const next = rebindPathIdentityFolderAnchorsV2(envelope, {
      sourcePath: "docs",
      targetPath: "renamed",
      completedAt,
    });

    expect(next.meta.commitSeq).toBe(envelope.meta.commitSeq + 1);
    expect(next.meta.committedAt).toBe(completedAt);
    expect(Object.keys(next.folderAnchors!.byAnchorId).sort()).toEqual([
      "folder:renamed",
      "folder:renamed/sub",
    ]);
    expect(next.folderAnchors!.byAnchorId["folder:renamed"]).toMatchObject({
      remoteId: "renamed",
      lastPath: "renamed",
      parentRemoteId: scope.filesRootId,
      confirmedGeneration: next.meta.commitSeq,
      confirmedAt: completedAt,
    });
    expect(next.folderAnchors!.byAnchorId["folder:renamed/sub"]).toMatchObject({
      remoteId: "renamed/sub",
      lastPath: "renamed/sub",
      parentRemoteId: "renamed",
    });
  });

  it("已收口时幂等返回原 envelope", () => {
    const envelope = envelopeWithFolders([
      folder("docs", null),
      folder("docs/sub", "docs"),
      folder("renamed", null),
      folder("renamed/sub", "renamed"),
    ]);
    const first = rebindPathIdentityFolderAnchorsV2(envelope, {
      sourcePath: "docs",
      targetPath: "renamed",
      completedAt,
    });

    const second = rebindPathIdentityFolderAnchorsV2(first, {
      sourcePath: "docs",
      targetPath: "renamed",
      completedAt: completedAt + 1,
    });

    expect(second).toBe(first);
  });

  it("源子树下仍有 file anchor 时失败关闭", () => {
    const envelope = envelopeWithFolders(
      [
        folder("docs", null),
        folder("docs/sub", "docs"),
        folder("renamed", null),
        folder("renamed/sub", "renamed"),
      ],
      {
        remoteFiles: [{ path: "docs/a.md", parentId: "docs", eTag: "etag-a" }],
        baseEntries: [{ path: "docs/a.md", hash: "aa".repeat(32), size: 1, eTag: "etag-a" }],
      },
    );

    expect(() => rebindPathIdentityFolderAnchorsV2(envelope, {
      sourcePath: "docs",
      targetPath: "renamed",
      completedAt,
    })).toThrow(FolderAnchorRebindError);
  });

  it("目标文件夹不在提交的远端索引时失败关闭", () => {
    const envelope = envelopeWithFolders([
      folder("docs", null),
      folder("docs/sub", "docs"),
      folder("renamed", null),
    ]);

    expect(() => rebindPathIdentityFolderAnchorsV2(envelope, {
      sourcePath: "docs",
      targetPath: "renamed",
      completedAt,
    })).toThrow(/target folder is missing/);
  });

  it("目标在源子树内时失败关闭", () => {
    const envelope = envelopeWithFolders([
      folder("docs", null),
      folder("docs/renamed", "docs"),
    ]);

    expect(() => rebindPathIdentityFolderAnchorsV2(envelope, {
      sourcePath: "docs",
      targetPath: "docs/renamed",
      completedAt,
    })).toThrow(/not outside the source/);
  });
});
