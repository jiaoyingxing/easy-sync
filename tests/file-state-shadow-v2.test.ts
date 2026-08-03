import { describe, expect, it } from "vitest";
import {
  compareFileStateShadowV2,
  createFileStateShadowEnvelopeV2,
} from "./helpers/file-state-shadow-v2";
import { projectFileStatePathViewV2 } from "../src/sync/file-state-reducer-v2";
import type {
  BaseFileEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
} from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hash = "a".repeat(64);
const folders: RemoteFolderEntry[] = [{
  path: "Notes",
  driveId: "folder-notes",
  parentId: scope.filesRootId,
  name: "Notes",
}];
const remoteEntries: RemoteFileEntry[] = [{
  path: "Notes/a.md",
  driveId: "file-a",
  parentId: "folder-notes",
  downloadUrl: "https://volatile.example/content",
  size: 10,
  mtime: 20,
  eTag: "etag-a",
  cTag: "ctag-a",
  sha256Hash: hash,
}];
const baseEntries: BaseFileEntry[] = [{
  path: "Notes/a.md",
  hash,
  size: 10,
  eTag: "etag-a",
}];

describe("V2 file-state compatibility shadow fixture", () => {
  it("round-trips the committed V1 planner state without volatile download URLs", () => {
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 3,
      commitSeq: 4,
      committedAt: 5,
      remoteEntries,
      remoteFolders: folders,
      baseEntries,
    });

    expect(compareFileStateShadowV2(envelope, {
      remoteEntries,
      baseEntries,
    })).toMatchObject({ status: "match", differenceKinds: [] });
    expect(projectFileStatePathViewV2(envelope).remoteEntries[0]).not.toHaveProperty("downloadUrl");
  });

  it("keeps a path anchor when its remote identity is already tombstoned", () => {
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 3,
      commitSeq: 4,
      committedAt: 5,
      remoteEntries: [],
      remoteFolders: folders,
      baseEntries,
    });

    expect(Object.values(envelope.anchors.byAnchorId)[0]).toMatchObject({
      lastPath: "Notes/a.md",
      remoteId: undefined,
    });
    expect(compareFileStateShadowV2(envelope, {
      remoteEntries: [],
      baseEntries,
    }).status).toBe("match");
  });

  it("rejects incomplete parent identity and reports real projection differences", () => {
    expect(() => createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 3,
      commitSeq: 4,
      committedAt: 5,
      remoteEntries: [{ ...remoteEntries[0]!, parentId: undefined }],
      remoteFolders: folders,
      baseEntries,
    })).toThrow("missing a parent id");

    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 3,
      commitSeq: 4,
      committedAt: 5,
      remoteEntries,
      remoteFolders: folders,
      baseEntries,
    });
    expect(compareFileStateShadowV2(envelope, {
      remoteEntries,
      baseEntries: [],
    })).toMatchObject({
      status: "differences",
      differenceKinds: expect.arrayContaining(["base-count", "base-entry"]),
    });
  });
});
