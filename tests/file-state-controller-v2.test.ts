import { describe, expect, it } from "vitest";
import {
  projectStatePathViewV2,
  remoteStateProjectionMatchesEnvelopeV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  replaceRemoteStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type { BaseFileEntry, RemoteFileEntry, RemoteFolderEntry } from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

function emptyEnvelope(): SyncStateEnvelopeV2 {
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 2, commitSeq: 1, committedAt: 1 },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 0,
      deltaLink: null,
      complete: true,
      itemsById: {},
    },
    anchors: { schemaVersion: 2, byAnchorId: {} },
  };
}

const folder: RemoteFolderEntry = {
  path: "Notes",
  driveId: "folder-notes",
  parentId: scope.filesRootId,
  name: "Notes",
};
const remoteA: RemoteFileEntry = {
  path: "Notes/a.md",
  driveId: "file-a",
  parentId: folder.driveId,
  size: 10,
  mtime: 20,
  eTag: "etag-a",
  cTag: "ctag-a",
  sha256Hash: hashA,
  downloadUrl: "https://volatile.example/a",
};
const baseA: BaseFileEntry = {
  path: remoteA.path,
  hash: hashA,
  size: remoteA.size,
  eTag: remoteA.eTag,
};
const remoteB: RemoteFileEntry = {
  path: "Notes/b.md",
  driveId: "file-b",
  parentId: folder.driveId,
  size: 12,
  mtime: 21,
  eTag: "etag-b",
  cTag: "ctag-b",
  sha256Hash: hashB,
};
const baseB: BaseFileEntry = {
  path: remoteB.path,
  hash: hashB,
  size: remoteB.size,
  eTag: remoteB.eTag,
};

describe("V2 file-state controller", () => {
  it("replaces and projects the complete remote identity state without volatile URLs", () => {
    const initial = emptyEnvelope();
    const next = replaceRemoteStateEnvelopeV2(initial, {
      entries: [remoteA],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
      committedAt: 2,
    });

    expect(projectStatePathViewV2(next)).toEqual({
      baseEntries: [],
      remoteEntries: [{ ...remoteA, downloadUrl: undefined }],
      remoteFolders: [folder],
      deltaLink: "delta-1",
      scope,
    });
    expect(next.meta.commitSeq).toBe(2);
    expect(next.remoteIndex.cursorRevision).toBe(1);
    expect(emptyEnvelope()).toEqual(initial);
  });

  it("does not advance a byte-for-byte equivalent remote refresh", () => {
    const first = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
    });
    const replay = replaceRemoteStateEnvelopeV2(first, {
      entries: [{ ...remoteA, downloadUrl: "https://new-volatile-url.example/a" }],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
    });

    expect(replay).toBe(first);
  });

  it("retains unchanged remote row identities during a partial refresh", () => {
    const first = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA, remoteB],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
    });
    const refreshed = replaceRemoteStateEnvelopeV2(first, {
      entries: [remoteA, { ...remoteB, eTag: "etag-b-next" }],
      folders: [folder],
      deltaLink: "delta-2",
      scope,
    });

    expect(refreshed.remoteIndex.itemsById[folder.driveId])
      .toBe(first.remoteIndex.itemsById[folder.driveId]);
    expect(refreshed.remoteIndex.itemsById[remoteA.driveId])
      .toBe(first.remoteIndex.itemsById[remoteA.driveId]);
    expect(refreshed.remoteIndex.itemsById[remoteB.driveId])
      .not.toBe(first.remoteIndex.itemsById[remoteB.driveId]);
  });

  it("distinguishes a cursor-only replay from changed remote identity facts", () => {
    const committed = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA],
      folders: [folder],
      deltaLink: "delta-reviewed",
      scope,
    });

    expect(remoteStateProjectionMatchesEnvelopeV2(committed, {
      entries: [{
        ...remoteA,
        downloadUrl: "https://new-volatile-url.example/a",
      }],
      folders: [folder],
      scope,
    })).toBe(true);
    expect(remoteStateProjectionMatchesEnvelopeV2(committed, {
      entries: [{
        ...remoteA,
        eTag: "etag-a-changed",
      }],
      folders: [folder],
      scope,
    })).toBe(false);
    expect(remoteStateProjectionMatchesEnvelopeV2(committed, {
      entries: [remoteA],
      folders: [{
        ...folder,
        eTag: "etag-folder-changed",
      }],
      scope,
    })).toBe(false);
  });

  it("publishes exact base anchors and preserves their stable identity", () => {
    const remoteState = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
    });
    const withBase = replaceBaseStateEnvelopeV2(remoteState, [baseA], 3);
    const updatedBase = upsertBaseStateEnvelopeV2(withBase, [{
      ...baseA,
      hash: hashB,
      size: 11,
    }], 4);
    const removedBase = removeBaseStateEnvelopeV2(updatedBase, [baseA.path], 5);

    expect(projectStatePathViewV2(withBase).baseEntries).toEqual([baseA]);
    expect(Object.values(withBase.anchors.byAnchorId)[0]).toMatchObject({
      remoteId: remoteA.driveId,
      lastPath: remoteA.path,
      remoteCTag: remoteA.cTag,
      confirmedBy: "equal-read",
    });
    expect(Object.keys(updatedBase.anchors.byAnchorId)).toEqual(
      Object.keys(withBase.anchors.byAnchorId),
    );
    expect(projectStatePathViewV2(updatedBase).baseEntries).toEqual([{
      ...baseA,
      hash: hashB,
      size: 11,
    }]);
    expect(projectStatePathViewV2(removedBase).baseEntries).toEqual([]);
  });

  it("records an ordered lineage when equal-read safely rebinds a rebuilt remote ID", () => {
    const withOldRemote = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
      committedAt: 2,
    });
    const withBase = replaceBaseStateEnvelopeV2(withOldRemote, [baseA], 3);
    const rebuiltRemote = {
      ...remoteA,
      driveId: "file-a-rebuilt",
      eTag: "etag-a-rebuilt",
    };
    const refreshed = replaceRemoteStateEnvelopeV2(withBase, {
      entries: [rebuiltRemote],
      folders: [folder],
      deltaLink: "delta-2",
      scope,
      committedAt: 4,
    });
    const rebound = upsertBaseStateEnvelopeV2(refreshed, [{
      ...baseA,
      eTag: rebuiltRemote.eTag,
    }], 5);

    expect(Object.values(rebound.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: `file:${remoteA.driveId}`,
        remoteId: rebuiltRemote.driveId,
        remoteIdentityLineage: [{
          fromRemoteId: remoteA.driveId,
          toRemoteId: rebuiltRemote.driveId,
          path: baseA.path,
          contentHash: baseA.hash,
          size: baseA.size,
          fromRemoteETag: remoteA.eTag,
          toRemoteETag: rebuiltRemote.eTag,
          confirmedAt: 5,
          confirmedBy: "equal-read",
        }],
      }),
    ]);
  });

  it("updates or removes one base without revalidating an unrelated divergent anchor", () => {
    const remoteState = replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA, remoteB],
      folders: [folder],
      deltaLink: "delta-1",
      scope,
      committedAt: 2,
    });
    const withBase = replaceBaseStateEnvelopeV2(
      remoteState,
      [baseA, baseB],
      3,
    );
    const refreshed = replaceRemoteStateEnvelopeV2(withBase, {
      entries: [
        { ...remoteA, eTag: "etag-a-2", cTag: "ctag-a-2" },
        {
          ...remoteB,
          eTag: "etag-b-2",
          cTag: "ctag-b-2",
          sha256Hash: hashC,
        },
      ],
      folders: [folder],
      deltaLink: "delta-2",
      scope,
      committedAt: 4,
    });

    const reconciled = upsertBaseStateEnvelopeV2(refreshed, [{
      ...baseA,
      eTag: "etag-a-2",
    }], 5);
    const removed = removeBaseStateEnvelopeV2(
      reconciled,
      [baseA.path],
      6,
    );

    expect(projectStatePathViewV2(reconciled).baseEntries).toEqual([
      { ...baseA, eTag: "etag-a-2" },
      baseB,
    ]);
    expect(reconciled.anchors.byAnchorId["file:file-b"]).toMatchObject({
      contentHash: baseB.hash,
      remoteETag: baseB.eTag,
      remoteCTag: remoteB.cTag,
      confirmedAt: 3,
    });
    expect(projectStatePathViewV2(removed).baseEntries).toEqual([baseB]);
    expect(() => upsertBaseStateEnvelopeV2(refreshed, [{
      ...baseA,
      eTag: "stale-etag",
    }], 5)).toThrow(`remote version mismatch: ${baseA.path}`);
  });

  it("fails closed on scope drift, missing parent identity, and path hierarchy mismatch", () => {
    expect(() => replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [remoteA],
      folders: [folder],
      deltaLink: null,
      scope: { ...scope, driveId: "other" },
    })).toThrow("scope");

    expect(() => replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [{ ...remoteA, parentId: undefined }],
      folders: [folder],
      deltaLink: null,
      scope,
    })).toThrow("parent id");

    expect(() => replaceRemoteStateEnvelopeV2(emptyEnvelope(), {
      entries: [{ ...remoteA, path: "Elsewhere/a.md" }],
      folders: [folder],
      deltaLink: null,
      scope,
    })).toThrow();
  });

  it("refuses to invent a base identity not present in remote state or prior anchors", () => {
    expect(() => replaceBaseStateEnvelopeV2(emptyEnvelope(), [baseA]))
      .toThrow("no remote identity");
  });
});
