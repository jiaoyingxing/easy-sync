import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { compareV1WithV2Shadow } from "../src/sync/read-only-shadow-v2";
import { SyncEngine } from "../src/sync/sync-engine";
import { SyncActionType } from "../src/sync/types";
import type { LocalFileEntry, RemoteFileEntry, SyncPlan, SyncScope } from "../src/sync/types";

const scope: SyncScope = {
  accountId: "account-id",
  driveId: "drive-id",
  vaultFolderId: "vault-id",
  filesRootId: "files-root-id",
};

function folder(id: string, name: string, parentId: string): DriveItem {
  return { id, name, folder: { childCount: 1 }, parentReference: { id: parentId } };
}

function file(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    size: 4,
    eTag: `etag-${id}`,
    cTag: `ctag-${id}`,
    parentReference: { id: parentId },
    file: { hashes: { sha256Hash: "aa".repeat(32) } },
  };
}

const remoteItems = [
  folder("notes-id", "Notes", scope.filesRootId),
  file("note-id", "note.md", "notes-id"),
];
const remote: RemoteFileEntry = {
  path: "Notes/note.md",
  driveId: "note-id",
  parentId: "notes-id",
  size: 4,
  mtime: 0,
  eTag: "etag-note-id",
  cTag: "ctag-note-id",
  sha256Hash: "aa".repeat(32),
};
const local: LocalFileEntry = {
  path: remote.path,
  size: 4,
  mtime: 1,
  hash: "aa".repeat(32),
  binary: false,
};

function input(overrides: Partial<Parameters<typeof compareV1WithV2Shadow>[0]> = {}) {
  const baseEntries = [{ path: remote.path, hash: local.hash, size: 4, eTag: remote.eTag }];
  const v1Plan = new SyncEngine().generatePlan([local], [remote], baseEntries, []);
  return {
    v1Scope: scope,
    v2Scope: scope,
    remoteItems,
    v1RemoteEntries: [remote],
    localEntries: [local],
    baseEntries,
    skippedLarge: [],
    v1Plan,
    includeRemotePath: () => true,
    ...overrides,
  };
}

describe("V2 read-only shadow", () => {
  it("matches V1 scope, remote ID/path and plan classification on the same input", () => {
    const report = compareV1WithV2Shadow(input());

    expect(report).toMatchObject({
      status: "match",
      remoteCounts: { v1: 1, v2: 1 },
      planCounts: { v1: 0, v2: 0 },
      differences: [],
      mutations: [],
      manifestWrites: 0,
    });
  });

  it("reports remote ID/path and plan differences without changing the V1 plan", () => {
    const v1Plan: SyncPlan = {
      items: [{ type: SyncActionType.Download, path: "files/Notes/note.md", remote }],
      lastTotalFiles: 1,
      confirmed: false,
    };
    const report = compareV1WithV2Shadow(input({
      v1RemoteEntries: [{ ...remote, path: "files/Notes/note.md" }],
      v1Plan,
    }));

    expect(report.status).toBe("mismatch");
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "remote-identity", key: "note-id" }),
      expect.objectContaining({ dimension: "plan", key: expect.stringContaining("files/Notes/note.md|download") }),
    ]));
    expect(v1Plan.items).toHaveLength(1);
    expect(report.mutations).toEqual([]);
  });

  it("preserves plan rejection reasons in the comparison signature", () => {
    const v1Plan: SyncPlan = {
      items: [{
        type: SyncActionType.Conflict,
        path: remote.path,
        local,
        remote,
        reason: "reason.bothSidesModified",
      }],
      lastTotalFiles: 0,
      confirmed: false,
    };
    const report = compareV1WithV2Shadow(input({ baseEntries: [], v1Plan }));

    expect(report.status).toBe("mismatch");
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimension: "plan",
        key: `${remote.path}|conflict|reason.bothSidesModified|`,
      }),
      expect.objectContaining({
        dimension: "plan",
        key: `${remote.path}|conflict|reason.newFileBothSides|`,
      }),
    ]));
  });

  it("rejects a scope mismatch without producing state or file mutations", () => {
    const report = compareV1WithV2Shadow(input({
      v2Scope: { ...scope, filesRootId: "other-root" },
    }));

    expect(report.status).toBe("rejected");
    expect(report.rejectionReason).toBe("scope-mismatch");
    expect(report.mutations).toEqual([]);
    expect(report.manifestWrites).toBe(0);
  });

  it("rejects an incomplete V2 parent chain with the reason visible", () => {
    const report = compareV1WithV2Shadow(input({
      remoteItems: [file("note-id", "note.md", "missing-folder")],
    }));

    expect(report.status).toBe("rejected");
    expect(report.rejectionReason).toBe("remote-identity-incomplete");
    expect(report.rejectionDetail).toContain("missing parent");
    expect(report.mutations).toEqual([]);
    expect(report.manifestWrites).toBe(0);
  });
});
