import { describe, expect, it } from "vitest";
import {
  buildPublic113AnchoredFilePlan,
  PUBLIC_113_REENTRY_PROVENANCE,
} from "./helpers/public-1-1-3-reentry-fixture";
import {
  type BaseFileEntry,
  type LocalFileEntry,
  type RemoteFileEntry,
  SyncActionType,
} from "../src/sync/types";

const path = "notes/shared.md";
const base: BaseFileEntry = {
  path,
  hash: "11".repeat(32),
  size: 11,
  eTag: "etag-base",
};

function local(
  hash = base.hash,
  size = base.size,
): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function remote(
  eTag = base.eTag,
  sha256Hash = base.hash,
  size = base.size,
): RemoteFileEntry {
  return {
    path,
    driveId: "remote-id",
    parentId: "files-root-id",
    eTag,
    cTag: `c-${eTag}`,
    sha256Hash,
    size,
    mtime: 2,
  };
}

describe("public 1.1.3 anchored-file reentry behavior", () => {
  it("binds the independent fixture to the exact public source", () => {
    expect(PUBLIC_113_REENTRY_PROVENANCE).toEqual({
      sourceCommit: "01a4ac30936a89c53ddbf521e7ea9399d71e79c4",
      syncEngineSha256:
        "ad708214a0421025889cd334f8d3e91b885b7df4747d55ecd425fe8a2a8aa581",
      syncExecutorSha256:
        "d24af74247d08256454c14524559fcc7e03e0a65b3e9c2ee6475c70dca8fdde5",
    });
  });

  it("downloads a newer remote version when the old device stayed unchanged", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      local: local(),
      remote: remote("etag-new", "22".repeat(32), 12),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path,
      }),
    ]);
  });

  it("keeps an offline edit as conflict when the remote also advanced", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      local: local("33".repeat(32), 13),
      remote: remote("etag-new", "22".repeat(32), 12),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        reason: "reason.bothSidesModified",
      }),
    ]);
  });

  it("keeps an offline local deletion as conflict when the remote advanced", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      remote: remote("etag-new", "22".repeat(32), 12),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        reason: "reason.localDeletedRemoteModified",
      }),
    ]);
  });

  it("allows a legitimate one-sided edit with the public base eTag", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      local: local("33".repeat(32), 13),
      remote: remote(),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path,
        baseEtag: "etag-base",
      }),
    ]);
  });

  it("allows a legitimate one-sided local deletion of an unchanged remote", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      remote: remote(),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.DeleteRemote,
        path,
        reason: "reason.fileDeletedLocally",
        remote: expect.objectContaining({
          driveId: "remote-id",
          eTag: "etag-base",
        }),
      }),
    ]);
  });

  it("asks before applying a remote deletion to unchanged local content", () => {
    const plan = buildPublic113AnchoredFilePlan({
      path,
      local: local(),
      base,
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path,
        reason: "reason.fileDeletedFromRemote",
      }),
    ]);
  });
});
