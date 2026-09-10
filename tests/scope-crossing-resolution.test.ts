import { describe, expect, it } from "vitest";
import {
  buildScopeCrossingResolutionSnapshotV1,
  findScopeCrossingCoveringHintV1,
  type ScopeCrossingResolutionFactsV1,
} from "../src/sync/scope-crossing-resolution";
import {
  type LocalFolderMoveHintV1,
  type SyncScope,
} from "../src/sync/types";

const scope: SyncScope = {
  accountId: "acc",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};

function hint(
  remoteId: string,
  fromPath: string,
  toPath: string,
  observedAt = 1000,
): LocalFolderMoveHintV1 {
  return { version: 1, scope, remoteId, fromPath, toPath, observedAt };
}

function facts(input: {
  folderAnchors?: Array<{ remoteId: string; lastPath: string }>;
  fileAnchors?: Array<{ remoteId: string; lastPath: string }>;
  folderHints?: LocalFolderMoveHintV1[];
  fileHints?: LocalFolderMoveHintV1[];
  scope?: SyncScope;
}): ScopeCrossingResolutionFactsV1 {
  return {
    envelope: {
      scope: input.scope ?? scope,
      folderAnchors: {
        byAnchorId: Object.fromEntries(
          (input.folderAnchors ?? []).map((anchor, index) => [`fa${index}`, anchor]),
        ),
      },
      anchors: {
        byAnchorId: Object.fromEntries(
          (input.fileAnchors ?? []).map((anchor, index) => [`fa-file${index}`, anchor]),
        ),
      },
    } as never,
    folderMoveHints: input.folderHints ?? [],
    fileMoveHints: input.fileHints ?? [],
  };
}

describe("scope-crossing covering hint resolution", () => {
  it("resolves the folder root row through the covering folder hint", () => {
    const resolved = findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        folderAnchors: [{ remoteId: "folder-1", lastPath: "Notes" }],
        folderHints: [hint("folder-1", "Notes", "Archive")],
      }),
    );
    expect(resolved).toMatchObject({ kind: "folder", anchorLastPath: "Notes" });
    expect(resolved?.hint.toPath).toBe("Archive");
  });

  it("resolves a nested anchored folder row through the covering root hint", () => {
    const resolved = findScopeCrossingCoveringHintV1(
      "Notes/Sub",
      facts({
        folderAnchors: [
          { remoteId: "folder-1", lastPath: "Notes" },
          { remoteId: "folder-2", lastPath: "Notes/Sub" },
        ],
        folderHints: [hint("folder-1", "Notes", "Archive")],
      }),
    );
    expect(resolved).toMatchObject({ kind: "folder", anchorLastPath: "Notes" });
  });

  it("resolves the exact file row through the file hint only at its root path", () => {
    const resolved = findScopeCrossingCoveringHintV1(
      "Notes/a.md",
      facts({
        fileAnchors: [{ remoteId: "file-1", lastPath: "Notes/a.md" }],
        fileHints: [hint("file-1", "Notes/a.md", "Archive/a.md")],
      }),
    );
    expect(resolved).toMatchObject({ kind: "file", anchorLastPath: "Notes/a.md" });

    // File hints are root-only: no subtree coverage.
    expect(findScopeCrossingCoveringHintV1(
      "Notes/a.md.bak",
      facts({
        fileAnchors: [{ remoteId: "file-1", lastPath: "Notes/a.md" }],
        fileHints: [hint("file-1", "Notes/a.md", "Archive/a.md")],
      }),
    )).toBeNull();
  });

  it("returns null for a row without any covering hint (drift form)", () => {
    expect(findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        folderAnchors: [{ remoteId: "folder-1", lastPath: "Notes" }],
      }),
    )).toBeNull();
  });

  it("returns null when the hint is not bound to a committed anchor", () => {
    expect(findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        folderAnchors: [{ remoteId: "folder-other", lastPath: "Notes" }],
        folderHints: [hint("folder-1", "Notes", "Archive")],
      }),
    )).toBeNull();
    expect(findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        folderAnchors: [{ remoteId: "folder-1", lastPath: "NotesOld" }],
        folderHints: [hint("folder-1", "Notes", "Archive")],
      }),
    )).toBeNull();
  });

  it("returns null when the hint destination is the vault trash", () => {
    expect(findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        folderAnchors: [{ remoteId: "folder-1", lastPath: "Notes" }],
        folderHints: [hint("folder-1", "Notes", ".trash/Notes")],
      }),
    )).toBeNull();
  });

  it("returns null when the hint belongs to another sync scope", () => {
    expect(findScopeCrossingCoveringHintV1(
      "Notes",
      facts({
        scope: { ...scope, driveId: "other-drive" },
        folderAnchors: [{ remoteId: "folder-1", lastPath: "Notes" }],
        folderHints: [hint("folder-1", "Notes", "Archive")],
      }),
    )).toBeNull();
  });

  it("builds the same snapshot through the shared core and drifts on hint changes", () => {
    const input = facts({
      fileAnchors: [{ remoteId: "file-1", lastPath: "Notes/a.md" }],
      fileHints: [hint("file-1", "Notes/a.md", "Archive/a.md")],
    });
    const snapshot = buildScopeCrossingResolutionSnapshotV1("Notes/a.md", input);
    expect(snapshot).toMatchObject({
      version: 1,
      kind: "file",
      rowPath: "Notes/a.md",
      fromPath: "Notes/a.md",
      toPath: "Archive/a.md",
      remoteId: "file-1",
    });
    expect(snapshot).not.toBeNull();

    const moved = buildScopeCrossingResolutionSnapshotV1("Notes/a.md", facts({
      fileAnchors: [{ remoteId: "file-1", lastPath: "Notes/a.md" }],
      fileHints: [hint("file-1", "Notes/a.md", "Archive/sub/a.md", 2000)],
    }));
    expect(moved?.revision).not.toBe(snapshot?.revision);
  });
});
