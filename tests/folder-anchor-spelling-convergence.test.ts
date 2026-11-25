import { describe, expect, it, vi } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import {
  applyConvergedFolderAnchorSpellingV2,
  deriveConvergedFolderAnchorSpellingsV2,
} from "../src/sync/folder-anchor-spelling-convergence";
import { planFolderStateV2 } from "../src/sync/folder-state-v2";
import { planIdentityRenamesV2 } from "../src/sync/identity-rename-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import { toRemoteScanFactsV1 } from "../src/sync/remote-facts-adapter";
import type {
  FolderAnchorV2,
  SyncAnchorV2,
  SyncStateEnvelopeV2,
} from "../src/sync/state-envelope-v2";
import type { LocalFileEntry, LocalFolderEntry } from "../src/sync/types";
import {
  findRemoteItemByPath,
  makeHarness,
} from "./helpers/state-v2-activation-harness";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const size = 10;

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
): SyncAnchorV2 {
  return {
    anchorId: `file:${remoteId}`,
    remoteId,
    lastPath,
    contentHash: hashA,
    size,
    remoteETag: `etag-${remoteId}`,
    confirmedAt: 1,
    confirmedBy: "equal-read",
  };
}

function envelope(input: {
  remoteFolderName: string;
  anchorPath: string;
  extraFolders?: Array<{ id: string; name: string; parentId: string }>;
  extraFiles?: Array<{ id: string; name: string; parentId: string }>;
  fileAnchorPath?: string;
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
    ...(input.extraFolders ?? []).map((folder): DriveItem => ({
      id: folder.id,
      name: folder.name,
      parentReference: { id: folder.parentId },
      folder: {},
      eTag: `etag-${folder.id}`,
      cTag: `ctag-${folder.id}`,
    })),
    {
      id: "file-a",
      name: "a.md",
      parentReference: { id: folderId },
      file: { hashes: { sha256Hash: hashA } },
      size,
      eTag: "etag-a",
      cTag: "ctag-file-a",
    },
    ...(input.extraFiles ?? []).map((file): DriveItem => ({
      id: file.id,
      name: file.name,
      parentReference: { id: file.parentId },
      file: { hashes: { sha256Hash: hashA } },
      size,
      eTag: `etag-${file.id}`,
      cTag: `ctag-${file.id}`,
    })),
  ];
  const folderAnchors: Record<string, FolderAnchorV2> = {
    [`folder:${folderId}`]: folderAnchor(folderId, input.anchorPath),
  };
  for (const folder of input.extraFolders ?? []) {
    folderAnchors[`folder:${folder.id}`] = folderAnchor(
      folder.id,
      `${input.anchorPath}/${folder.name}`,
      folder.parentId,
    );
  }
  const fileAnchors: Record<string, SyncAnchorV2> = {
    "file:file-a": fileAnchor(
      "file-a",
      input.fileAnchorPath ?? `${input.anchorPath}/a.md`,
    ),
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
    anchors: { schemaVersion: 2, byAnchorId: fileAnchors },
    folderAnchors: { schemaVersion: 2, byAnchorId: folderAnchors },
  };
}

function localFile(path: string): LocalFileEntry {
  return { path, hash: hashA, size, mtime: 1, binary: false };
}

function localFolders(...paths: string[]): LocalFolderEntry[] {
  return paths.map((path) => ({ path }));
}

const deriveInput = (
  state: SyncStateEnvelopeV2,
  patches: Partial<Parameters<typeof deriveConvergedFolderAnchorSpellingsV2>[0]> = {},
) => ({
  envelope: state,
  localFiles: [localFile("NOTES/a.md")],
  localFolders: localFolders("NOTES"),
  localFolderScanComplete: true,
  ...patches,
});

describe("folder anchor spelling convergence", () => {
  it("derives the stale root once both sides use the same spelling", () => {
    const derived = deriveConvergedFolderAnchorSpellingsV2(
      deriveInput(envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" })),
    );
    expect(derived).toEqual([{
      anchorId: "folder:folder-notes",
      remoteId: "folder-notes",
      fromPath: "Notes",
      toPath: "NOTES",
    }]);
  });

  it("stays inert while the cloud still uses the anchored spelling", () => {
    expect(deriveConvergedFolderAnchorSpellingsV2(
      deriveInput(envelope({ remoteFolderName: "Notes", anchorPath: "Notes" })),
    )).toEqual([]);
  });

  it("stays inert when local and cloud still disagree on the spelling", () => {
    expect(deriveConvergedFolderAnchorSpellingsV2(
      deriveInput(
        envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" }),
        {
          localFiles: [localFile("notes/a.md")],
          localFolders: localFolders("notes"),
        },
      ),
    )).toEqual([]);
  });

  it("stays inert for a preserved or out-of-scope spelling", () => {
    const state = envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" });
    expect(deriveConvergedFolderAnchorSpellingsV2(
      deriveInput(state, { preserveFolderPath: (path) => path === "NOTES" }),
    )).toEqual([]);
    expect(deriveConvergedFolderAnchorSpellingsV2(
      deriveInput(state, { includeFolderPath: (path) => path !== "NOTES" }),
    )).toEqual([]);
  });

  it("collapses a nested stale anchor into the outer root", () => {
    const state = envelope({
      remoteFolderName: "NOTES",
      anchorPath: "Notes",
      extraFolders: [{
        id: "folder-sub",
        name: "Sub",
        parentId: "folder-notes",
      }],
    });
    const derived = deriveConvergedFolderAnchorSpellingsV2({
      ...deriveInput(state, {
        localFiles: [localFile("NOTES/a.md"), localFile("NOTES/Sub/b.md")],
        localFolders: localFolders("NOTES", "NOTES/Sub"),
      }),
    });
    expect(derived.map((entry) => entry.fromPath)).toEqual(["Notes"]);
  });

  it("rebinds the whole subtree from the committed index spelling", () => {
    const state = envelope({
      remoteFolderName: "NOTES",
      anchorPath: "Notes",
      extraFolders: [{
        id: "folder-sub",
        name: "Sub",
        parentId: "folder-notes",
      }],
    });
    const derived = deriveConvergedFolderAnchorSpellingsV2({
      ...deriveInput(state, {
        localFiles: [localFile("NOTES/a.md"), localFile("NOTES/Sub/b.md")],
        localFolders: localFolders("NOTES", "NOTES/Sub"),
      }),
    });
    const result = applyConvergedFolderAnchorSpellingV2(
      state as SyncStateEnvelopeV2,
      derived[0],
      20,
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.convergedFolderAnchors).toBe(2);
    expect(result.convergedFileAnchors).toBe(1);
    expect(Object.values(
      result.envelope.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath).sort()).toEqual(["NOTES", "NOTES/Sub"]);
    expect(result.envelope.anchors.byAnchorId["file:file-a"]).toMatchObject({
      lastPath: "NOTES/a.md",
      confirmedBy: "folder-spelling-convergence",
    });
    expect(result.envelope.meta.commitSeq).toBe(state.meta.commitSeq + 1);
  });

  it("rejects when a descendant does not project to the reviewed spelling", () => {
    const state = envelope({
      remoteFolderName: "NOTES",
      anchorPath: "Notes",
      extraFolders: [{
        id: "folder-sub",
        name: "Sub",
        parentId: "folder-notes",
      }],
    });
    // The remote child identity lives under another parent path: translating
    // the subtree would claim a node the index does not put there.
    state.remoteIndex.itemsById["folder-sub"]!.parentId = scope.filesRootId;
    state.remoteIndex.itemsById["folder-sub"]!.name = "Elsewhere";
    const result = applyConvergedFolderAnchorSpellingV2(
      state as SyncStateEnvelopeV2,
      {
        anchorId: "folder:folder-notes",
        remoteId: "folder-notes",
        fromPath: "Notes",
        toPath: "NOTES",
      },
      20,
    );
    expect(result).toEqual({ status: "rejected", reason: "projection-changed" });
  });

  it("rejects a stale review whose remote root already changed", () => {
    const state = envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" });
    const result = applyConvergedFolderAnchorSpellingV2(
      state,
      {
        anchorId: "folder:folder-notes",
        remoteId: "folder-notes",
        fromPath: "Notes",
        toPath: "OldSpelling",
      },
      20,
    );
    expect(result).toEqual({ status: "rejected", reason: "source-changed" });
  });

  it("clears the folder conflict and the phantom file move after the rebind", () => {
    const state = envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" });
    const derived = deriveConvergedFolderAnchorSpellingsV2({
      ...deriveInput(state),
    });
    const applied = applyConvergedFolderAnchorSpellingV2(
      state,
      derived[0],
      20,
    );
    if (applied.status !== "accepted") throw new Error("expected acceptance");
    const folderPlan = planFolderStateV2({
      envelope: applied.envelope,
      localFiles: [localFile("NOTES/a.md")],
      localFolders: localFolders("NOTES"),
      localFolderScanComplete: true,
    });
    expect(folderPlan.items).toEqual([]);
    expect(planIdentityRenamesV2(
      applied.envelope,
      [localFile("NOTES/a.md")],
    )).toEqual([]);
  });

  it("never mints a file move whose parent is only a spelling alias", () => {
    const state = envelope({ remoteFolderName: "NOTES", anchorPath: "Notes" });
    // Local already followed the folder rename across the parent spelling; the
    // folded local lookup used to read that as "local stayed at the anchor" and
    // planned a self move that could never receipt.
    expect(planIdentityRenamesV2(state, [localFile("NOTES/a.md")])).toEqual([]);
    // Local untouched, cloud folder renamed: the folder layer owns the
    // divergence, so the file layer withholds its move too.
    expect(planIdentityRenamesV2(state, [localFile("Notes/a.md")])).toEqual([]);
  });
});

describe("folder spelling convergence round", () => {
  it("converges a case-only rename once both sides use the same spelling", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    harness.remoteItemState.find((item) => item.id === "folder-notes")!.name =
      "NOTES";

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      filesMoved: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
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

  it("retires a legacy intent-only parent-spelling move zero-write", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    harness.remoteItemState.find((item) => item.id === "folder-notes")!.name =
      "NOTES";
    // A parent rename may advance the child's version token; the move effect
    // is path-level, so the settle decision must not depend on the old eTag.
    harness.remoteItemState.find((item) => item.id === "file-a")!.eTag =
      "etag-a-after-parent-rename";
    // OneDrive path addressing ignores case: the source spelling still
    // resolves to the same live item as the target.
    const original = harness.client.getDriveItemMetadata;
    harness.client.getDriveItemMetadata = vi.fn(
      async (vaultName: string, path: string) =>
        await original(vaultName, path)
        ?? findRemoteItemByPath(harness.remoteItemState, "NOTES/a.md"),
    ) as never;
    await harness.state.beginMutationIntent({
      version: 1,
      operationId: "legacy-parent-spelling-move",
      planRevision: 1,
      scope,
      action: "moveLocal",
      path: "NOTES/a.md",
      sourcePath: "Notes/a.md",
      expectedLocal: { exists: true, hash: hashA, size },
      expectedRemote: {
        exists: true,
        driveId: "file-a",
        eTag: "etag-a",
        size,
        sha256Hash: hashA,
      },
      createdAt: 1,
    });

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({ success: true, deferred: 0, errors: 0 });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["NOTES"]);
  }, 120_000);

  it("settles a legacy receipted parent-spelling move through its checkpoint", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    harness.remoteItemState.find((item) => item.id === "folder-notes")!.name =
      "NOTES";
    await harness.state.beginMutationIntent({
      version: 1,
      operationId: "receipted-parent-spelling-move",
      planRevision: 1,
      scope,
      action: "moveLocal",
      path: "NOTES/a.md",
      sourcePath: "Notes/a.md",
      expectedLocal: { exists: true, hash: hashA, size },
      expectedRemote: {
        exists: true,
        driveId: "file-a",
        eTag: "etag-a",
        size,
        sha256Hash: hashA,
      },
      createdAt: 1,
    });
    // A case-insensitive host may have executed the move and written a
    // receipt whose target parent was rejected by the then-stale index. The
    // receipt's target parent now matches the committed index; the existing
    // receipt validation owns the commit.
    await harness.state.recordMutationReceipt({
      version: 1,
      operationId: "receipted-parent-spelling-move",
      completedAt: 2,
      checkpoint: {
        baseUpserts: [{
          path: "NOTES/a.md",
          hash: hashA,
          size,
          eTag: "etag-a",
        }],
        baseRemovals: ["Notes/a.md"],
        remoteUpserts: [{
          path: "NOTES/a.md",
          driveId: "file-a",
          parentId: "folder-notes",
          size,
          mtime: 1,
          eTag: "etag-a",
          cTag: "ctag-a",
          sha256Hash: hashA,
        }],
        remoteDeletes: ["Notes/a.md"],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    });

    const round = await harness.executor.run("manual");

    expect(round).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["NOTES"]);
  }, 120_000);

  it("keeps a legacy record blocked while its planned result is not present", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual", {}, false, undefined, {
      activateV2State: true,
    });
    // Local followed a local rename; the cloud still sits at the anchored
    // spelling, so the planned target does not exist remotely.
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("NOTES");
    harness.localEntryState[0].path = "NOTES/a.md";
    await harness.state.beginMutationIntent({
      version: 1,
      operationId: "legacy-parent-spelling-move",
      planRevision: 1,
      scope,
      action: "moveLocal",
      path: "NOTES/a.md",
      sourcePath: "Notes/a.md",
      expectedLocal: { exists: true, hash: hashA, size },
      expectedRemote: {
        exists: true,
        driveId: "file-a",
        eTag: "etag-a",
        size,
        sha256Hash: hashA,
      },
      createdAt: 1,
    });

    const round = await harness.executor.run("manual");

    // The planned target does not exist remotely, so the record stays.
    expect(round.mutationRecovery).toMatchObject({
      state: "blocked",
      remaining: 1,
      isolated: true,
    });
    expect(harness.state.mutationLedger).toHaveLength(1);
  }, 120_000);
});
