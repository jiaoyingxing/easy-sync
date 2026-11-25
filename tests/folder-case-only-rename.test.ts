import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { planFolderStateV2 } from "../src/sync/folder-state-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import { toRemoteScanFactsV1 } from "../src/sync/remote-facts-adapter";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type { LocalFileEntry, LocalFolderEntry } from "../src/sync/types";
import { makeHarness } from "./helpers/state-v2-activation-harness";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const size = 10;

function envelope(input: {
  remoteFolderName: string;
  anchorPath: string;
}): SyncStateEnvelopeV2 {
  const folderId = "folder-notes";
  const items: DriveItem[] = [
    {
      id: folderId,
      name: input.remoteFolderName,
      parentReference: { id: scope.filesRootId },
      folder: {},
      eTag: `etag-${folderId}`,
      cTag: `ctag-${folderId}`,
    },
    {
      id: "file-a",
      name: "a.md",
      parentReference: { id: folderId },
      file: { hashes: { sha256Hash: hashA } },
      size,
      eTag: "etag-file-a",
      cTag: "ctag-file-a",
    },
  ];
  const folderAnchor: FolderAnchorV2 = {
    anchorId: `folder:${folderId}`,
    remoteId: folderId,
    lastPath: input.anchorPath,
    parentRemoteId: scope.filesRootId,
    remoteETag: `etag-${folderId}`,
    confirmedGeneration: 1,
    confirmedAt: 1,
  };
  const fileAnchor: SyncAnchorV2 = {
    anchorId: "file:file-a",
    remoteId: "file-a",
    lastPath: `${input.anchorPath}/a.md`,
    contentHash: hashA,
    size,
    remoteETag: "etag-file-a",
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 1, committedAt: 1 },
    scope,
    remoteIndex: buildRemoteIndexV2(
      toRemoteScanFactsV1(items),
      scope.filesRootId,
      null,
      1,
    ).index,
    anchors: { schemaVersion: 2, byAnchorId: { [fileAnchor.anchorId]: fileAnchor } },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: { [folderAnchor.anchorId]: folderAnchor },
    },
  };
}

function localFile(path: string, hash = hashA): LocalFileEntry {
  return { path, hash, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

function plan(local: {
  envelope: SyncStateEnvelopeV2;
  localFiles: LocalFileEntry[];
  localFolders: LocalFolderEntry[];
  allowCaseOnlyFolderRename?: boolean;
}) {
  return planFolderStateV2({
    envelope: local.envelope,
    localFiles: local.localFiles,
    localFolders: local.localFolders,
    localFolderScanComplete: true,
    ...(local.allowCaseOnlyFolderRename === true
      ? { allowCaseOnlyFolderRename: true }
      : {}),
  });
}

describe("one-sided case-only folder rename (stable-id providers)", () => {
  it("plans a remote move when only the local spelling changed", () => {
    expect(plan({
      envelope: envelope({ remoteFolderName: "Notes", anchorPath: "Notes" }),
      localFiles: [localFile("NOTES/a.md")],
      localFolders: localFolders("NOTES"),
      allowCaseOnlyFolderRename: true,
    }).items).toEqual([expect.objectContaining({
      type: "move-remote",
      sourcePath: "Notes",
      targetPath: "NOTES",
      remoteId: "folder-notes",
    })]);
  });

  it("plans a local move when only the cloud spelling changed", () => {
    expect(plan({
      envelope: envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" }),
      localFiles: [localFile("Notes/a.md")],
      localFolders: localFolders("Notes"),
      allowCaseOnlyFolderRename: true,
    }).items).toEqual([expect.objectContaining({
      type: "move-local",
      sourcePath: "Notes",
      targetPath: "NOTES",
      remoteId: "folder-notes",
    })]);
  });

  it("keeps the visible conflict when the subtree changed with the rename", () => {
    expect(plan({
      envelope: envelope({ remoteFolderName: "Notes", anchorPath: "Notes" }),
      localFiles: [localFile("NOTES/a.md", "c".repeat(64))],
      localFolders: localFolders("NOTES"),
      allowCaseOnlyFolderRename: true,
    }).items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-rename-evidence-conflict",
    })]);
    expect(plan({
      envelope: envelope({ remoteFolderName: "Notes", anchorPath: "Notes" }),
      localFiles: [localFile("NOTES/a.md"), localFile("NOTES/new.md")],
      localFolders: localFolders("NOTES"),
      allowCaseOnlyFolderRename: true,
    }).items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-rename-evidence-conflict",
    })]);
  });

  it("keeps the conflict when a local file occupies the old identity", () => {
    expect(plan({
      envelope: envelope({ remoteFolderName: "Notes", anchorPath: "Notes" }),
      localFiles: [localFile("Notes"), localFile("NOTES/a.md")],
      localFolders: localFolders("NOTES"),
      allowCaseOnlyFolderRename: true,
    }).items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-rename-evidence-conflict",
    })]);
  });

  it("keeps the committed conflict when the caller does not allow it", () => {
    expect(plan({
      envelope: envelope({ remoteFolderName: "Notes", anchorPath: "Notes" }),
      localFiles: [localFile("NOTES/a.md")],
      localFolders: localFolders("NOTES"),
    }).items).toEqual([expect.objectContaining({
      type: "conflict",
      path: "Notes",
      reason: "local-rename-evidence-conflict",
    })]);
  });
});

describe("one-sided case-only folder rename round (OneDrive)", () => {
  it("local-only rename moves the cloud folder in one round and stays zero", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      foldersMoved: 1,
      deferred: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["NOTES"]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["NOTES/a.md"]);
    const stable = await harness.executor.run("manual");
    expect(stable).toMatchObject({ success: true, deferred: 0, errors: 0 });
  }, 120_000);

  it("cloud-only rename moves the local folder in one round and stays zero", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.remoteItemState.find((item) => item.id === "folder-notes")!.name =
      "NOTES";

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      foldersMoved: 1,
      deferred: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.localFolderPaths.has("NOTES")).toBe(true);
    expect(harness.localEntryState.map((entry) => entry.path)).toEqual([
      "NOTES/a.md",
    ]);
    const stable = await harness.executor.run("manual");
    expect(stable).toMatchObject({ success: true, deferred: 0, errors: 0 });
  }, 120_000);

  it("keeps the conflict when the renamed folder also gains content", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    harness.localEntryState.push({
      path: "NOTES/new.md",
      hash: "b".repeat(64),
      size,
      mtime: 1,
      binary: false,
    });

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({
      uploaded: 0,
      foldersMoved: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([expect.objectContaining({
      path: "Notes",
      issueCode: "local-rename-evidence-conflict",
    })]);
  }, 120_000);
});
