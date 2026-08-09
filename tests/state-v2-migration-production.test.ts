import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { DriveItem } from "../src/onedrive/types";
import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
  SyncPlanItem,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";
import { generateFileDecisionPlanV2 } from "../src/sync/file-decision-planner-v2";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import {
  buildStateV2MigrationCandidate,
  commitReviewedStateV2MigrationCandidate,
  isStateV2Manifest,
  migrateV1ToV2,
  readStateV2Manifest,
  type StateV2MigrationInput,
  type StateV2MigrationPaths,
} from "../src/sync/state-v2-migration";
import {
  STATE_V1_MIGRATION_CASES,
  migrationCase,
  type MigrationFixture,
} from "./fixtures/state-v1-migration-cases";

const paths: StateV2MigrationPaths = {
  committed: "plugin/state-v2.json",
  next: "plugin/state-v2.next.json",
  previous: "plugin/state-v2.previous.json",
  recovery: "plugin/state-v2.recovery.json",
  manifest: "plugin/state-v2.manifest.json",
  manifestNext: "plugin/state-v2.manifest.next.json",
  v1Backup: "plugin/state-v1.backup.json",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((entry) =>
        entry.slice(0, entry.lastIndexOf("/")) === path
      ),
      folders: [],
    })),
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

function toInput(fixture: MigrationFixture): StateV2MigrationInput {
  const localEntries: LocalFileEntry[] = fixture.local.map((entry) => ({
    ...entry,
    mtime: 1,
    binary: false,
  }));
  const remoteItems: DriveItem[] = fixture.remote
    .filter((entry) => entry.parentId !== null)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      eTag: entry.eTag,
      cTag: entry.cTag,
      parentReference: { id: entry.parentId! },
      ...(entry.kind === "folder"
        ? { folder: {} }
        : { file: { hashes: entry.contentHash ? { sha256Hash: entry.contentHash } : undefined } }),
    }));
  return {
    scope: {
      accountId: fixture.accountId,
      driveId: fixture.driveId,
      vaultFolderId: fixture.vaultFolderId,
      filesRootId: fixture.filesRootId,
    },
    lifecycleEpoch: fixture.v1Generation,
    localScanComplete: fixture.localScanComplete,
    remoteScanComplete: fixture.remoteScanComplete,
    localEntries,
    remoteItems,
    v1Base: fixture.v1Base,
    v1Snapshot: { base: fixture.v1Base, deltaLink: fixture.v1DeltaLink },
    cloudHints: fixture.cloudAnchors,
    now: 1234,
  };
}

describe("production V1 to V2 migration", () => {
  it("uses one strict manifest validator for every V2 control record", () => {
    const manifest = {
      schemaVersion: 2,
      activeState: "state-v2.json",
      stateCommitSeq: 1,
      lifecycleEpoch: 1,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
      migratedAt: 1,
      legacyAutoSyncAllowed: false,
    };
    expect(isStateV2Manifest(manifest)).toBe(true);
    expect(isStateV2Manifest({ ...manifest, migratedAt: Number.NaN }))
      .toBe(false);
  });

  it.each(STATE_V1_MIGRATION_CASES.map((fixture) => [fixture.id, fixture] as const))(
    "runs %s through real V2 serialization with no user-file mutation",
    async (id, fixture) => {
      const { adapter, files } = makeAdapter();
      const result = await migrateV1ToV2(adapter, paths, toInput(fixture));

      expect(result.mutations).toEqual([]);
      if (id === "missing-drive-id") {
        expect(result).toMatchObject({ status: "aborted", reason: "remote-identity-incomplete" });
        expect(files.size).toBe(0);
        return;
      }
      expect(result.status).toBe("committed");
      expect(result.envelope?.remoteIndex.deltaLink).toBeNull();
      expect(result.manifest?.legacyAutoSyncAllowed).toBe(false);
      expect(files.has(paths.v1Backup)).toBe(true);
      expect(files.has(paths.manifest)).toBe(true);
      expect(await readStateV2Manifest(adapter, paths.manifest)).toEqual(result.manifest);
    },
  );

  it("publishes nothing when either full scan is incomplete", async () => {
    const { adapter, files } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    input.localScanComplete = false;

    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({
      status: "aborted",
      reason: "scan-incomplete",
      mutations: [],
    });
    expect(files.size).toBe(0);
  });

  it("commits exact same-path folder anchors in the first V2 envelope", async () => {
    const { adapter } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    input.folderScanComplete = true;
    input.localFolders = [{ path: "notes" }, { path: "local-only" }];

    const result = await migrateV1ToV2(adapter, paths, input);

    expect(result.status).toBe("committed");
    expect(Object.values(result.envelope?.folderAnchors?.byAnchorId ?? {}))
      .toContainEqual(expect.objectContaining({
        lastPath: "notes",
        confirmedGeneration: 1,
      }));
    expect(Object.values(result.envelope?.folderAnchors?.byAnchorId ?? {}))
      .not.toContainEqual(expect.objectContaining({ lastPath: "local-only" }));
  });

  it("keeps the V1 backup and committed envelope when manifest publication fails, then resumes", async () => {
    const { adapter, files, spies } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    const originalRename = spies.rename.getMockImplementation()!;
    spies.rename.mockImplementation(async (from: string, to: string) => {
      if (from === paths.manifestNext) throw new Error("manifest rename failed");
      return originalRename(from, to);
    });

    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({
      status: "aborted",
      reason: "state-save-failure",
      mutations: [],
    });
    expect(files.has(paths.committed)).toBe(true);
    expect(files.has(paths.v1Backup)).toBe(true);
    expect(files.has(paths.manifest)).toBe(false);

    spies.rename.mockImplementation(originalRename);
    input.now = 5678;
    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({ status: "committed" });
    expect(files.has(paths.manifest)).toBe(true);
  });

  it("refuses production activation when any V1 base anchor is unresolved", async () => {
    const { adapter, files } = makeAdapter();
    const input = toInput(migrationCase("same-hash-multiple-paths"));
    input.requireCompleteAnchors = true;

    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({
      status: "aborted",
      reason: "anchor-incomplete",
      pending: [{
        sourcePath: "old.md",
        reason: "identity-not-unique-or-unverified",
      }],
      mutations: [],
    });
    expect(files.size).toBe(0);
  });

  it("retires an ambiguous old path only in the reviewed unpublished candidate", () => {
    const input = toInput(migrationCase("same-hash-multiple-paths"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const result = buildStateV2MigrationCandidate(candidateInput);

    expect(result).toMatchObject({
      status: "ready",
      pending: [],
      mutations: [],
    });
    expect(result.envelope?.anchors.byAnchorId).toEqual({});

    const laterOldPathPlan = generateFileDecisionPlanV2({
      localEntries: [],
      remoteEntries: [{
        path: "old.md",
        driveId: "new-object-at-old-path",
        parentId: "vault-root",
        size: 8,
        mtime: 2,
        eTag: "etag-new-object",
        cTag: "ctag-new-object",
        sha256Hash: "aa".repeat(32),
      }],
      baseEntries: Object.values(
        result.envelope?.anchors.byAnchorId ?? {},
      ).map((anchor) => ({
        path: anchor.lastPath,
        hash: anchor.contentHash,
        size: anchor.size,
        eTag: anchor.remoteETag ?? "",
      })),
      skippedLarge: [],
    });
    expect(laterOldPathPlan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path: "old.md",
      }),
    ]);
    expect(laterOldPathPlan.items).not.toContainEqual(
      expect.objectContaining({ type: SyncActionType.DeleteRemote }),
    );
  });

  it("relocates a V1 anchor only from a unique cross-path eTag and exact local base", () => {
    const input = toInput(migrationCase("path-already-moved"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    const base = candidateInput.v1Base[0]!;
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === "remote-moved"
        ? { ...item, eTag: base.eTag, file: {} }
        : item);
    candidateInput.v1RemoteEntries = [{
      path: "new/path.md",
      driveId: "remote-moved",
      parentId: "folder-new",
      size: base.size,
      mtime: 2,
      eTag: base.eTag,
      cTag: "ctag-moved",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const result = buildStateV2MigrationCandidate(candidateInput);

    expect(result.status).toBe("ready");
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-moved"])
      .toMatchObject({
        remoteId: "remote-moved",
        lastPath: "new/path.md",
        contentHash: base.hash,
        size: base.size,
        remoteETag: base.eTag,
      });
  });

  it("never lets a cross-path relocation overwrite an existing target-path V1 base", () => {
    const input = toInput(migrationCase("path-already-moved"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    const oldBase = candidateInput.v1Base[0]!;
    const targetBase = {
      path: "new/path.md",
      hash: "bb".repeat(32),
      size: oldBase.size,
      eTag: oldBase.eTag,
    };
    candidateInput.v1Base = [oldBase, targetBase];
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === "remote-moved"
        ? { ...item, eTag: oldBase.eTag, file: {} }
        : item);
    candidateInput.v1RemoteEntries = [{
      path: targetBase.path,
      driveId: "remote-moved",
      parentId: "folder-new",
      size: targetBase.size,
      mtime: 2,
      eTag: targetBase.eTag,
      cTag: "ctag-moved",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const result = buildStateV2MigrationCandidate(candidateInput);

    expect(result.status).toBe("ready");
    expect(Object.keys(result.envelope?.anchors.byAnchorId ?? {})).toEqual([
      "migrated:remote-moved",
    ]);
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-moved"])
      .toMatchObject({
        lastPath: targetBase.path,
        contentHash: targetBase.hash,
      });
  });

  it("preserves a V1 base anchor that is intentionally outside the device scan scope", async () => {
    const { adapter } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    input.localEntries = [];
    input.preservedBasePaths = ["notes/a.md"];
    input.requireCompleteAnchors = true;

    const result = await migrateV1ToV2(adapter, paths, input);

    expect(result.status).toBe("committed");
    expect(result.pending).toEqual([]);
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-a"]).toMatchObject({
      remoteId: "remote-a",
      lastPath: "notes/a.md",
      contentHash: "aa".repeat(32),
      remoteETag: "etag-a",
    });
  });

  it("retains the historical drive identity when both live sides changed from the V1 base", () => {
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    candidateInput.localEntries = [{
      ...candidateInput.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === "remote-a"
        ? {
            ...item,
            eTag: "etag-a-live-changed",
            file: { hashes: { sha256Hash: "dd".repeat(32) } },
          }
        : item);
    candidateInput.v1RemoteEntries = [{
      path: "notes/a.md",
      driveId: "remote-a",
      parentId: "folder-notes",
      size: 10,
      mtime: 1,
      eTag: "etag-a",
      cTag: "ctag-a",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const result = buildStateV2MigrationCandidate(candidateInput);

    expect(result.status).toBe("ready");
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-a"]).toMatchObject({
      remoteId: "remote-a",
      lastPath: "notes/a.md",
      contentHash: "aa".repeat(32),
      remoteETag: "etag-a",
    });
    expect(result.mutations).toEqual([]);
  });

  it("retains a proven historical drive identity when the live remote item disappeared", () => {
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    candidateInput.localEntries = [{
      ...candidateInput.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    candidateInput.remoteItems = candidateInput.remoteItems.filter(
      (item) => item.id !== "remote-a",
    );
    candidateInput.v1RemoteEntries = [{
      path: "notes/a.md",
      driveId: "remote-a",
      parentId: "folder-notes",
      size: 10,
      mtime: 1,
      eTag: "etag-a",
      cTag: "ctag-a",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const result = buildStateV2MigrationCandidate(candidateInput);

    expect(result.status).toBe("ready");
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-a"]).toMatchObject({
      remoteId: "remote-a",
      lastPath: "notes/a.md",
      contentHash: "aa".repeat(32),
      remoteETag: "etag-a",
    });
    expect(result.envelope?.remoteIndex.itemsById["remote-a"]).toBeUndefined();
  });

  it("does not inherit a replacement remote id without V1 base-version proof", () => {
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    candidateInput.localEntries = [{
      ...candidateInput.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === "remote-a"
        ? {
            ...item,
            id: "replacement-a",
            eTag: "etag-replacement",
            file: { hashes: { sha256Hash: "dd".repeat(32) } },
          }
        : item);
    candidateInput.v1RemoteEntries = [{
      path: "notes/a.md",
      driveId: "remote-a",
      parentId: "folder-notes",
      size: 10,
      mtime: 1,
      eTag: "etag-not-the-base",
      cTag: "ctag-old",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    expect(buildStateV2MigrationCandidate(candidateInput)).toMatchObject({
      status: "aborted",
      reason: "anchor-incomplete",
      pending: [{
        sourcePath: "notes/a.md",
        reason: "identity-not-unique-or-unverified",
      }],
      mutations: [],
      envelope: null,
    });
  });

  it("uses only an exact unique public download intent to retain an advanced remote identity", () => {
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    const base = candidateInput.v1Base[0]!;
    candidateInput.localEntries = [{
      ...candidateInput.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === "remote-a"
        ? {
            ...item,
            eTag: "etag-a-live-changed",
            file: {},
          }
        : item);
    candidateInput.v1RemoteEntries = [{
      path: base.path,
      driveId: "remote-a",
      parentId: "folder-notes",
      size: base.size,
      mtime: 2,
      eTag: "etag-a-live-changed",
      cTag: "ctag-a-live-changed",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;

    const exactLedger: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "public-1.1.3-interrupted-download",
        planRevision: 1,
        scope: { ...candidateInput.scope },
        action: "download",
        path: base.path,
        expectedLocal: {
          exists: true,
          hash: base.hash,
          size: base.size,
        },
        expectedRemote: {
          exists: true,
          driveId: "remote-a",
          eTag: "etag-a-live-changed",
          size: base.size,
        },
        createdAt: 1233,
      },
      receipt: null,
    };

    expect(buildStateV2MigrationCandidate(candidateInput)).toMatchObject({
      status: "aborted",
      reason: "anchor-incomplete",
      envelope: null,
    });

    const prepared = buildStateV2MigrationCandidate({
      ...candidateInput,
      v1MutationLedger: [exactLedger],
    });
    expect(prepared.status).toBe("ready");
    expect(prepared.envelope?.anchors.byAnchorId["migrated:remote-a"])
      .toMatchObject({
        remoteId: "remote-a",
        lastPath: base.path,
        contentHash: base.hash,
        size: base.size,
        remoteETag: base.eTag,
      });
    const publishedEmptyAccount = structuredClone(exactLedger);
    publishedEmptyAccount.intent.scope.accountId = "";
    expect(buildStateV2MigrationCandidate({
      ...candidateInput,
      v1MutationLedger: [publishedEmptyAccount],
    }).status).toBe("ready");

    const wrongETag = structuredClone(exactLedger);
    if (wrongETag.intent.expectedRemote.exists) {
      wrongETag.intent.expectedRemote.eTag = "etag-after-intent";
    }
    const wrongScope = structuredClone(exactLedger);
    wrongScope.intent.scope.accountId = "another-account";
    const wrongLocal = structuredClone(exactLedger);
    if (wrongLocal.intent.expectedLocal.exists) {
      wrongLocal.intent.expectedLocal.hash = "dd".repeat(32);
    }
    const duplicate = structuredClone(exactLedger);
    duplicate.intent.operationId = "duplicate-public-download";

    for (const ledger of [
      [wrongETag],
      [wrongScope],
      [wrongLocal],
      [exactLedger, duplicate],
    ]) {
      expect(buildStateV2MigrationCandidate({
        ...candidateInput,
        v1MutationLedger: ledger,
      })).toMatchObject({
        status: "aborted",
        reason: "anchor-incomplete",
        envelope: null,
      });
    }
  });

  it("uses only an exact unique public pending conflict to retain the changed remote identity", () => {
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot: _v1Snapshot, ...candidateInput } = input;
    const base = candidateInput.v1Base[0]!;
    const local = {
      ...candidateInput.localEntries[0]!,
      size: 11,
      hash: "cc".repeat(32),
    };
    const remote = {
      path: base.path,
      driveId: "remote-a",
      parentId: "folder-notes",
      size: 12,
      mtime: 2,
      eTag: "etag-a-live-changed",
      cTag: "ctag-a-live-changed",
    };
    candidateInput.localEntries = [local];
    candidateInput.remoteItems = candidateInput.remoteItems.map((item) =>
      item.id === remote.driveId
        ? {
            ...item,
            size: remote.size,
            eTag: remote.eTag,
            cTag: remote.cTag,
            file: {},
          }
        : item);
    candidateInput.v1RemoteEntries = [remote];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;
    candidateInput.ancestorHashesByPath = {
      [base.path]: base.hash,
    };
    const exactConflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: base.path,
      local,
      remote,
      reason: "reason.bothSidesModified",
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: candidateInput.scope.accountId,
        scope: { ...candidateInput.scope },
        local: {
          exists: true,
          hash: local.hash,
          size: local.size,
        },
        remote: {
          exists: true,
          driveId: remote.driveId,
          eTag: remote.eTag,
        },
        ancestorHash: base.hash,
      },
    };

    expect(buildStateV2MigrationCandidate(candidateInput)).toMatchObject({
      status: "aborted",
      reason: "anchor-incomplete",
      envelope: null,
    });

    const prepared = buildStateV2MigrationCandidate({
      ...candidateInput,
      v1VaultName: "testVault",
      v1PendingConflicts: [exactConflict],
    });
    expect(prepared.status).toBe("ready");
    expect(prepared.envelope?.anchors.byAnchorId["migrated:remote-a"])
      .toMatchObject({
        remoteId: remote.driveId,
        lastPath: base.path,
        contentHash: base.hash,
        size: base.size,
        remoteETag: base.eTag,
        ancestorHash: base.hash,
      });

    const preparedWithoutAncestorBytes = buildStateV2MigrationCandidate({
      ...candidateInput,
      ancestorHashesByPath: {},
      v1VaultName: "testVault",
      v1PendingConflicts: [exactConflict],
    });
    expect(preparedWithoutAncestorBytes.status).toBe("ready");
    expect(
      preparedWithoutAncestorBytes.envelope
        ?.anchors.byAnchorId["migrated:remote-a"],
    ).toMatchObject({
      remoteId: remote.driveId,
      lastPath: base.path,
      contentHash: base.hash,
      size: base.size,
      remoteETag: base.eTag,
    });
    expect(
      preparedWithoutAncestorBytes.envelope
        ?.anchors.byAnchorId["migrated:remote-a"],
    ).not.toHaveProperty("ancestorHash");

    const preparedAfterLocalUpgrade = buildStateV2MigrationCandidate({
      ...candidateInput,
      ancestorHashesByPath: {},
      localEntries: [{ ...local, hash: "ff".repeat(32), size: 13 }],
      v1VaultName: "testVault",
      v1PendingConflicts: [exactConflict],
    });
    expect(preparedAfterLocalUpgrade.status).toBe("ready");
    expect(
      preparedAfterLocalUpgrade.envelope
        ?.anchors.byAnchorId["migrated:remote-a"],
    ).toMatchObject({ remoteId: remote.driveId, lastPath: base.path });

    const wrongETag = structuredClone(exactConflict);
    if (wrongETag.decisionToken?.remote.exists) {
      wrongETag.decisionToken.remote.eTag = "etag-after-review";
    }
    const wrongScope = structuredClone(exactConflict);
    wrongScope.decisionToken!.scope.accountId = "another-account";
    const wrongLocal = structuredClone(exactConflict);
    if (wrongLocal.decisionToken?.local.exists) {
      wrongLocal.decisionToken.local.hash = "dd".repeat(32);
    }
    const wrongAncestor = structuredClone(exactConflict);
    wrongAncestor.decisionToken!.ancestorHash = "ee".repeat(32);
    const duplicate = structuredClone(exactConflict);

    for (const conflicts of [
      [wrongETag],
      [wrongScope],
      [wrongLocal],
      [wrongAncestor],
      [exactConflict, duplicate],
    ]) {
      expect(buildStateV2MigrationCandidate({
        ...candidateInput,
        v1VaultName: "testVault",
        v1PendingConflicts: conflicts,
      })).toMatchObject({
        status: "aborted",
        reason: "anchor-incomplete",
        envelope: null,
      });
    }
  });

  it("publishes the exact reviewed non-zero candidate with the manifest last", async () => {
    const { adapter, files } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot, ...candidateInput } = input;
    candidateInput.localEntries = [{
      ...candidateInput.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    candidateInput.v1RemoteEntries = [{
      path: "notes/a.md",
      driveId: "remote-a",
      parentId: "folder-notes",
      size: 10,
      mtime: 1,
      eTag: "etag-a",
      cTag: "ctag-a",
    }];
    candidateInput.allowChangedAnchors = true;
    candidateInput.requireCompleteAnchors = true;
    candidateInput.folderScanComplete = true;
    candidateInput.localFolders = [{ path: "notes" }];
    const prepared = buildStateV2MigrationCandidate(candidateInput);
    expect(prepared.status).toBe("ready");

    const result = await commitReviewedStateV2MigrationCandidate(
      adapter,
      paths,
      {
        candidate: prepared.envelope!,
        canonicalIdentity: {
          version: 2,
          scope: candidateInput.scope,
          sourceCommitSeq: 1,
          digest: "reviewed-non-zero-plan",
        },
        v1Snapshot,
        now: 4321,
      },
    );

    expect(result).toMatchObject({
      status: "committed",
      pending: [],
      mutations: [],
      manifest: {
        stateCommitSeq: 1,
        legacyAutoSyncAllowed: false,
      },
    });
    expect(result.envelope?.anchors.byAnchorId["migrated:remote-a"])
      .toMatchObject({
        remoteId: "remote-a",
        contentHash: "aa".repeat(32),
      });
    expect(files.has(paths.v1Backup)).toBe(true);
    expect(files.has(paths.committed)).toBe(true);
    expect(files.has(paths.manifest)).toBe(true);
  });

  it("rejects a reviewed candidate whose sealed source revision is not exact", async () => {
    const { adapter, files } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot, ...candidateInput } = input;
    candidateInput.folderScanComplete = true;
    candidateInput.localFolders = [{ path: "notes" }];
    const prepared = buildStateV2MigrationCandidate(candidateInput);

    await expect(commitReviewedStateV2MigrationCandidate(
      adapter,
      paths,
      {
        candidate: prepared.envelope!,
        canonicalIdentity: {
          version: 2,
          scope: candidateInput.scope,
          sourceCommitSeq: 2,
          digest: "wrong-source",
        },
        v1Snapshot,
      },
    )).rejects.toThrow("not bound");
    expect(files.size).toBe(0);
  });

  it("never reuses an already committed manifest for a different reviewed candidate", async () => {
    const { adapter } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    const { v1Snapshot, ...candidateInput } = input;
    candidateInput.folderScanComplete = true;
    candidateInput.localFolders = [{ path: "notes" }];
    const prepared = buildStateV2MigrationCandidate(candidateInput);
    const identity = {
      version: 2 as const,
      scope: candidateInput.scope,
      sourceCommitSeq: 1,
      digest: "first-reviewed-plan",
    };
    await expect(commitReviewedStateV2MigrationCandidate(
      adapter,
      paths,
      {
        candidate: prepared.envelope!,
        canonicalIdentity: identity,
        v1Snapshot,
      },
    )).resolves.toMatchObject({ status: "committed" });

    const differentCandidate = structuredClone(prepared.envelope!);
    differentCandidate.remoteIndex.deltaLink = "different-reviewed-cursor";
    await expect(commitReviewedStateV2MigrationCandidate(
      adapter,
      paths,
      {
        candidate: differentCandidate,
        canonicalIdentity: {
          ...identity,
          digest: "different-reviewed-plan",
        },
        v1Snapshot,
      },
    )).rejects.toThrow(
      "does not match the reviewed migration candidate",
    );
  });

  it("does not activate a stale pre-manifest envelope after V1 facts changed", async () => {
    const { adapter, files, spies } = makeAdapter();
    const initial = toInput(migrationCase("normal-v1"));
    const originalRename = spies.rename.getMockImplementation()!;
    spies.rename.mockImplementation(async (from: string, to: string) => {
      if (from === paths.manifestNext) throw new Error("manifest rename failed");
      return originalRename(from, to);
    });
    await expect(migrateV1ToV2(adapter, paths, initial)).resolves.toMatchObject({
      status: "aborted",
      reason: "state-save-failure",
    });
    spies.rename.mockImplementation(originalRename);

    const changed = toInput(migrationCase("normal-v1"));
    changed.localEntries = [{
      ...changed.localEntries[0]!,
      hash: "cc".repeat(32),
    }];
    // Simulate an untyped/stale caller attempting to leak the candidate-only
    // relaxation into the publication API. Runtime publication must still
    // force the strict zero-state anchor rule.
    (changed as StateV2MigrationInput & {
      allowChangedAnchors: boolean;
    }).allowChangedAnchors = true;
    await expect(migrateV1ToV2(adapter, paths, changed)).resolves.toMatchObject({
      status: "aborted",
      reason: "committed-envelope-mismatch",
      mutations: [],
    });
    expect(files.has(paths.manifest)).toBe(false);
    expect(files.has(paths.v1Backup)).toBe(true);
    expect(files.has(paths.committed)).toBe(true);
  });

  it("loads a manifest-selected envelope and lets explicit reset discard only local sync state", async () => {
    const { adapter, files } = makeAdapter();
    const actualPaths = getEasySyncPaths(".obsidian");
    const actualMigrationPaths: StateV2MigrationPaths = {
      committed: actualPaths.stateV2File,
      next: actualPaths.stateV2NextFile,
      previous: actualPaths.stateV2PreviousFile,
      recovery: actualPaths.stateV2RecoveryFile,
      manifest: actualPaths.stateV2ManifestFile,
      manifestNext: actualPaths.stateV2ManifestNextFile,
      v1Backup: actualPaths.stateV1BackupFile,
    };
    const migrated = await migrateV1ToV2(
      adapter,
      actualMigrationPaths,
      toInput(migrationCase("normal-v1")),
    );
    expect(migrated.status).toBe("committed");
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({}),
      updatePluginData: vi.fn().mockResolvedValue(undefined),
      app: { vault: { adapter, configDir: ".obsidian" } },
      manifest: { id: "easy-sync", dir: actualPaths.pluginDir },
    };
    const state = new StateManager(plugin);
    await state.load();

    expect(state.legacyAutoSyncAllowed).toBe(false);
    expect(state.isV2StateActive).toBe(true);
    expect(state.remoteScope).toEqual(migrated.envelope?.scope);
    expect(state.remoteSnapshot.length).toBeGreaterThan(0);
    await expect(state.reset()).resolves.toBeUndefined();
    expect(state.isV2StateActive).toBe(false);
    expect(state.remoteSnapshot).toEqual([]);
    expect(files.has(actualPaths.stateV2ManifestFile)).toBe(false);
  });
});
