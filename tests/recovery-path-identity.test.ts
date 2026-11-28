// 找回读面的历史身份解析（`src/sync/recovery-path-identity.ts`）：直接命中、
// 文件改名提示、文件夹前缀翻译与歧义守卫。纯函数，无 IO。

import { describe, expect, it } from "vitest";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
} from "../src/sync/state-envelope-v2";
import type {
  LocalFolderMoveHintV1,
  SyncScope,
} from "../src/sync/types";
import { resolveRecoveryPathIdentityV1 } from "../src/sync/recovery-path-identity";

const SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};

function fileAnchor(input: {
  remoteId?: string;
  lastPath: string;
  remoteETag?: string;
}): SyncAnchorV2 {
  return {
    anchorId: `file:${input.remoteId ?? input.lastPath}`,
    ...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
    lastPath: input.lastPath,
    contentHash: "a".repeat(64),
    size: 10,
    ...(input.remoteETag === undefined ? {} : { remoteETag: input.remoteETag }),
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
}

function folderAnchor(input: {
  remoteId: string;
  lastPath: string;
}): FolderAnchorV2 {
  return {
    anchorId: `folder:${input.remoteId}`,
    remoteId: input.remoteId,
    lastPath: input.lastPath,
    parentRemoteId: "root",
    confirmedGeneration: 1,
    confirmedAt: 1,
  };
}

function hint(input: {
  remoteId: string;
  fromPath: string;
  toPath: string;
  observedAt?: number;
  scope?: SyncScope;
}): LocalFolderMoveHintV1 {
  return {
    version: 1,
    scope: input.scope ?? SCOPE,
    remoteId: input.remoteId,
    fromPath: input.fromPath,
    toPath: input.toPath,
    observedAt: input.observedAt ?? 1,
  };
}

function resolve(input: {
  path: string;
  fileAnchors?: SyncAnchorV2[];
  folderAnchors?: FolderAnchorV2[];
  fileMoveHints?: LocalFolderMoveHintV1[];
  folderMoveHints?: LocalFolderMoveHintV1[];
}) {
  return resolveRecoveryPathIdentityV1({
    path: input.path,
    scope: SCOPE,
    fileAnchors: input.fileAnchors ?? [],
    folderAnchors: input.folderAnchors ?? [],
    fileMoveHints: input.fileMoveHints ?? [],
    folderMoveHints: input.folderMoveHints ?? [],
  });
}

describe("resolveRecoveryPathIdentityV1", () => {
  it("resolves the committed anchor at the queried path", () => {
    expect(resolve({
      path: "notes/a.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "notes/a.md",
        remoteETag: "etag-1",
      })],
    })).toEqual({
      kind: "resolved",
      remoteId: "file-1",
      remoteETag: "etag-1",
      baselinePath: "notes/a.md",
    });
  });

  it("does not fall through to hints when the path owns a local-only anchor", () => {
    expect(resolve({
      path: "notes/new.md",
      fileAnchors: [
        fileAnchor({ lastPath: "notes/new.md" }),
        fileAnchor({ remoteId: "file-1", lastPath: "notes/old.md" }),
      ],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/old.md",
        toPath: "notes/new.md",
      })],
    })).toBeUndefined();
  });

  it("resolves a locally renamed file through its device hint", () => {
    expect(resolve({
      path: "notes/new.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "notes/old.md",
        remoteETag: "etag-1",
      })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/old.md",
        toPath: "notes/new.md",
      })],
    })).toEqual({
      kind: "resolved",
      remoteId: "file-1",
      remoteETag: "etag-1",
      baselinePath: "notes/old.md",
    });
  });

  it("resolves a case-only rename without treating the alias as occupied", () => {
    expect(resolve({
      path: "Notes/a.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "Notes/A.md",
        remoteETag: "etag-1",
      })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "Notes/A.md",
        toPath: "Notes/a.md",
      })],
    })).toEqual({
      kind: "resolved",
      remoteId: "file-1",
      remoteETag: "etag-1",
      baselinePath: "Notes/A.md",
    });
  });

  it("refuses a hint whose destination another identity still occupies", () => {
    expect(resolve({
      path: "notes/b.md",
      fileAnchors: [
        fileAnchor({ remoteId: "file-1", lastPath: "notes/a.md" }),
        fileAnchor({ remoteId: "file-2", lastPath: "notes/B.md" }),
      ],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/a.md",
        toPath: "notes/b.md",
      })],
    })).toBeUndefined();
  });

  it("reports pending-rename when two identities claim the queried path", () => {
    expect(resolve({
      path: "notes/d.md",
      fileAnchors: [
        fileAnchor({ remoteId: "file-1", lastPath: "notes/a.md" }),
        fileAnchor({ remoteId: "file-2", lastPath: "notes/c.md" }),
      ],
      fileMoveHints: [
        hint({ remoteId: "file-1", fromPath: "notes/a.md", toPath: "notes/d.md" }),
        hint({ remoteId: "file-2", fromPath: "notes/c.md", toPath: "notes/d.md" }),
      ],
    })).toEqual({ kind: "pending-rename" });
  });

  it("keeps one claim per identity when duplicate hints survive in device data", () => {
    expect(resolve({
      path: "notes/new.md",
      fileAnchors: [fileAnchor({ remoteId: "file-1", lastPath: "notes/old.md" })],
      fileMoveHints: [
        hint({ remoteId: "file-1", fromPath: "notes/old.md", toPath: "notes/new.md" }),
        hint({ remoteId: "file-1", fromPath: "notes/old.md", toPath: "notes/new.md" }),
      ],
    })).toMatchObject({ kind: "resolved", remoteId: "file-1" });
  });

  it("ignores hints whose binding anchor no longer sits at the source path", () => {
    expect(resolve({
      path: "notes/new.md",
      fileAnchors: [fileAnchor({ remoteId: "file-1", lastPath: "notes/current.md" })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/old.md",
        toPath: "notes/new.md",
      })],
    })).toBeUndefined();
  });

  it("ignores out-of-scope and vault-trash hints", () => {
    const otherScope: SyncScope = { ...SCOPE, driveId: "other-drive" };
    expect(resolve({
      path: "notes/new.md",
      fileAnchors: [fileAnchor({ remoteId: "file-1", lastPath: "notes/old.md" })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/old.md",
        toPath: "notes/new.md",
        scope: otherScope,
      })],
    })).toBeUndefined();
    expect(resolve({
      path: ".trash/new.md",
      fileAnchors: [fileAnchor({ remoteId: "file-1", lastPath: "notes/old.md" })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "notes/old.md",
        toPath: ".trash/new.md",
      })],
    })).toBeUndefined();
  });

  it("resolves a file under a renamed folder through the folder hint", () => {
    expect(resolve({
      path: "Projects/New/note.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "Projects/Old/note.md",
        remoteETag: "etag-1",
      })],
      folderAnchors: [folderAnchor({
        remoteId: "folder-1",
        lastPath: "Projects/Old",
      })],
      folderMoveHints: [hint({
        remoteId: "folder-1",
        fromPath: "Projects/Old",
        toPath: "Projects/New",
      })],
    })).toEqual({
      kind: "resolved",
      remoteId: "file-1",
      remoteETag: "etag-1",
      baselinePath: "Projects/Old/note.md",
    });
  });

  it("resolves a file renamed before its folder was renamed", () => {
    expect(resolve({
      path: "Projects/New/renamed.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "Projects/Old/note.md",
      })],
      folderAnchors: [folderAnchor({
        remoteId: "folder-1",
        lastPath: "Projects/Old",
      })],
      fileMoveHints: [hint({
        remoteId: "file-1",
        fromPath: "Projects/Old/note.md",
        toPath: "Projects/Old/renamed.md",
        observedAt: 10,
      })],
      folderMoveHints: [hint({
        remoteId: "folder-1",
        fromPath: "Projects/Old",
        toPath: "Projects/New",
        observedAt: 20,
      })],
    })).toMatchObject({
      kind: "resolved",
      remoteId: "file-1",
      baselinePath: "Projects/Old/note.md",
    });
  });

  it("undoes nested folder renames newest first", () => {
    expect(resolve({
      path: "Q/D/f.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "P/C/f.md",
      })],
      folderAnchors: [
        folderAnchor({ remoteId: "folder-p", lastPath: "P" }),
        folderAnchor({ remoteId: "folder-c", lastPath: "P/C" }),
      ],
      folderMoveHints: [
        hint({
          remoteId: "folder-c",
          fromPath: "P/C",
          toPath: "P/D",
          observedAt: 10,
        }),
        hint({
          remoteId: "folder-p",
          fromPath: "P",
          toPath: "Q",
          observedAt: 20,
        }),
      ],
    })).toMatchObject({
      kind: "resolved",
      remoteId: "file-1",
      baselinePath: "P/C/f.md",
    });
  });

  it("reports pending-rename when same-moment folder evidence cannot be ordered", () => {
    expect(resolve({
      path: "Q/D/f.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "P/C/f.md",
      })],
      folderAnchors: [
        folderAnchor({ remoteId: "folder-p", lastPath: "P" }),
        folderAnchor({ remoteId: "folder-c", lastPath: "P/C" }),
      ],
      folderMoveHints: [
        hint({
          remoteId: "folder-c",
          fromPath: "P/C",
          toPath: "P/D",
          observedAt: 10,
        }),
        hint({
          remoteId: "folder-p",
          fromPath: "P",
          toPath: "Q",
          observedAt: 10,
        }),
      ],
    })).toEqual({ kind: "pending-rename" });
  });

  it("refuses a folder hint whose destination another folder anchor occupies", () => {
    expect(resolve({
      path: "New/f.md",
      fileAnchors: [fileAnchor({
        remoteId: "file-1",
        lastPath: "Old/f.md",
      })],
      folderAnchors: [
        folderAnchor({ remoteId: "folder-1", lastPath: "Old" }),
        folderAnchor({ remoteId: "folder-2", lastPath: "New" }),
      ],
      folderMoveHints: [hint({
        remoteId: "folder-1",
        fromPath: "Old",
        toPath: "New",
      })],
    })).toBeUndefined();
  });

  it("returns undefined when the folder moved but the file was never anchored", () => {
    expect(resolve({
      path: "Projects/New/note.md",
      fileAnchors: [],
      folderAnchors: [folderAnchor({
        remoteId: "folder-1",
        lastPath: "Projects/Old",
      })],
      folderMoveHints: [hint({
        remoteId: "folder-1",
        fromPath: "Projects/Old",
        toPath: "Projects/New",
      })],
    })).toBeUndefined();
  });
});
